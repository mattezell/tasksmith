/**
 * Task Engine — the heart of TaskSmith.
 *
 * Watches inbox, assembles compiled prompts, invokes Claude Code CLI,
 * manages Ralph Loop, coordinates memory and notifications.
 */

import { execSync, execFileSync, spawnSync, spawn } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync,
  renameSync, unlinkSync, readdirSync, realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { v4 as uuidv4 } from "uuid";
import yaml from "js-yaml";
import type {
  Task, TaskStatus, Priority, Notification, MemoryEntry,
  OutboundCommsProvider, MemoryProvider, TaskSmithConfig,
  CircuitBreakerConfig,
} from "./types.js";
import type { MarkdownMemoryProvider } from "./providers/memory/providers.js";
import { isTaskFile, parseTaskFile, resolveProjectsDir } from "./config.js";
import type { SessionArchiver } from "./providers/memory/providers.js";

/** Parsed fields from Claude Code's --output-format json response. */
interface CCJsonResult {
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  session_id?: string;
  is_error?: boolean;
}

/** Validation result with diagnostic detail for operator-facing output. */
interface ValidationResult {
  passed: boolean;
  /** Combined stdout+stderr (truncated), used as error context for next iteration. */
  output: string;
  /** Exit code from the validation command (-1 for timeout). */
  exitCode: number;
  /** First N lines of stderr, the most useful diagnostic signal. */
  stderrHead: string;
  /** The actual command that was executed (after any worktree rewriting). */
  command: string;
  /** Failure classification: INFRA, BUILD, TEST, TIMEOUT, or NONE. */
  failureClass: "NONE" | "INFRA" | "BUILD" | "TEST" | "TIMEOUT";
}

/** Rate limit detection result. */
interface RateLimitInfo {
  isRateLimited: boolean;
  resetTime: Date | null;
  sleepMs: number;
}

/**
 * Detect rate limiting from Claude Code's JSON response.
 * Rate limit responses have: is_error=true, total_cost_usd=0, num_turns=1,
 * and result text matching "You've hit your limit · resets <time> (<tz>)".
 */
function detectRateLimit(parsed: CCJsonResult | null): RateLimitInfo {
  const none: RateLimitInfo = { isRateLimited: false, resetTime: null, sleepMs: 0 };
  if (!parsed || !parsed.is_error) return none;
  if (!parsed.result || !parsed.result.includes("hit your limit")) return none;

  // Parse reset time: "resets 6pm (America/Chicago)" or "resets 2:30am (America/Chicago)"
  const match = parsed.result.match(/resets?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*\(([^)]+)\)/i);
  if (!match) {
    // Detected rate limit but couldn't parse time — use a conservative 15min wait
    return { isRateLimited: true, resetTime: null, sleepMs: 15 * 60 * 1000 };
  }

  const [, timeStr, tz] = match;

  try {
    // Build a target date for today at the specified time
    const now = new Date();

    // Parse the time string (e.g. "6pm", "2:30am", "11pm")
    const timeParts = timeStr.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (!timeParts) {
      return { isRateLimited: true, resetTime: null, sleepMs: 15 * 60 * 1000 };
    }

    let hours = parseInt(timeParts[1], 10);
    const minutes = timeParts[2] ? parseInt(timeParts[2], 10) : 0;
    const ampm = timeParts[3].toLowerCase();

    if (ampm === "pm" && hours !== 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    // Create target time using Intl to handle timezone
    // Get current time in the specified timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || "0", 10);

    const nowInTz = new Date(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const resetInTz = new Date(get("year"), get("month") - 1, get("day"), hours, minutes, 0);

    // If reset time is in the past (already passed today), assume tomorrow
    if (resetInTz <= nowInTz) {
      resetInTz.setDate(resetInTz.getDate() + 1);
    }

    const sleepMs = resetInTz.getTime() - nowInTz.getTime();
    // Add 60s buffer to avoid hitting the limit again immediately
    const bufferedSleepMs = sleepMs + 60_000;
    // Cap at 12 hours to avoid runaway waits from parsing errors
    const cappedSleepMs = Math.min(bufferedSleepMs, 12 * 60 * 60 * 1000);

    const resetTime = new Date(now.getTime() + cappedSleepMs);
    return { isRateLimited: true, resetTime, sleepMs: cappedSleepMs };
  } catch {
    return { isRateLimited: true, resetTime: null, sleepMs: 15 * 60 * 1000 };
  }
}

// =============================================================================
// CIRCUIT BREAKER — detect stuck iteration patterns and eject early
// =============================================================================

/** Snapshot of a single iteration's outcome for circuit breaker analysis. */
export interface IterationSnapshot {
  iteration: number;
  failureClass: ValidationResult['failureClass'];
  exitCode: number;
  stderrFingerprint: string;
  contradiction: boolean;
  cumulativeCostUsd: number;
}

/** Result when the circuit breaker decides to eject a task. */
export interface EjectionResult {
  rule: string;   // INFRA_STUCK, CONTRADICTION_LOOP, STUCK_LOOP, COST_CEILING, TIMEOUT_STUCK
  reason: string;
}

// =============================================================================
// STRUCTURED TASK LOG — per-task JSONL event log for post-mortem analysis
// =============================================================================

/**
 * Append-only per-task JSONL logger.
 * Writes to `<workspace>/logs/task-<id>.jsonl`. Each line is a timestamped event.
 * Survives engine restarts (append-only file, no in-memory state).
 */
class TaskLogger {
  private filePath: string;

  constructor(workspace: string, taskId: string) {
    const logDir = join(workspace, "logs");
    mkdirSync(logDir, { recursive: true });
    this.filePath = join(logDir, `task-${taskId}.jsonl`);
  }

  private write(event: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    try {
      appendFileSync(this.filePath, line + "\n");
    } catch {
      // Non-fatal — structured log is best-effort. Console logging is primary.
    }
  }

  taskStart(task: { id: string; template: string; model: string; project: string; maxIterations: number }): void {
    this.write({ event: "task_start", task: task.id, template: task.template, model: task.model, project: task.project, max_iterations: task.maxIterations });
  }

  iterStart(taskId: string, iteration: number, model: string): void {
    this.write({ event: "iter_start", task: taskId, iter: iteration, model });
  }

  ccComplete(taskId: string, iteration: number, cc: CCJsonResult | null): void {
    this.write({
      event: "cc_complete", task: taskId, iter: iteration,
      turns: cc?.num_turns ?? null, cost: cc?.total_cost_usd ?? null,
      duration_ms: cc?.duration_ms ?? null, is_error: cc?.is_error ?? false,
      result_summary: cc?.result?.slice(0, 500) ?? null,
    });
  }

  validation(taskId: string, iteration: number, v: ValidationResult, contradiction: boolean): void {
    this.write({
      event: "validation", task: taskId, iter: iteration,
      cmd: v.command, exit_code: v.exitCode, passed: v.passed,
      classification: v.failureClass,
      stderr: v.stderrHead?.slice(0, 500) || null,
      contradiction,
    });
  }

  iterEnd(taskId: string, iteration: number, passed: boolean, failureClass: string, cumulativeCost: number): void {
    this.write({
      event: "iter_end", task: taskId, iter: iteration,
      passed, failure_class: failureClass, cumulative_cost: Math.round(cumulativeCost * 10000) / 10000,
    });
  }

  rateLimited(taskId: string, iteration: number, sleepMs: number): void {
    this.write({ event: "rate_limited", task: taskId, iter: iteration, sleep_ms: sleepMs });
  }

  ejected(taskId: string, iteration: number, rule: string, reason: string): void {
    this.write({ event: "ejected", task: taskId, iter: iteration, rule, reason });
  }

  taskResume(taskId: string, resumeFrom: number, priorCost: number): void {
    this.write({ event: "task_resume", task: taskId, resume_from: resumeFrom, prior_cost: priorCost });
  }

  taskEnd(taskId: string, status: string, diagnostics: Record<string, unknown>): void {
    this.write({ event: "task_end", task: taskId, status, ...diagnostics });
  }
}

/**
 * Normalize stderr into a deterministic fingerprint for comparison.
 * Strips PIDs, timestamps, hex addresses, and noise to detect repeated identical errors.
 */
export function fingerprint(stderrHead: string): string {
  if (!stderrHead) return "";
  return stderrHead
    .toLowerCase()
    // Strip PIDs (e.g. "pid 12345", "[12345]")
    .replace(/\bpid\s*\d+/g, "pid X")
    .replace(/\[\d{3,}\]/g, "[X]")
    // Strip timestamps (ISO, HH:MM:SS, epoch-like) — note: runs after toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}[.\d]*/g, "TIMESTAMP")
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, "TIMESTAMP")
    // Strip hex addresses (0x7fff..., 0xDEADBEEF)
    .replace(/0x[0-9a-f]{4,}/g, "0xHEX")
    // Take first 3 non-empty lines
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("|");
}

/**
 * Count the longest contiguous tail run in an array where predicate holds.
 * E.g. [F, T, T, T] with predicate=T → 3 (last 3 match).
 */
export function consecutiveTailRun<T>(arr: T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) count++;
    else break;
  }
  return count;
}

/**
 * Evaluate the circuit breaker rules against the iteration history.
 * Returns an EjectionResult if the task should be ejected, or null to continue.
 *
 * Rules checked in order:
 *   1. INFRA_STUCK — N consecutive identical INFRA failures
 *   2. CONTRADICTION_LOOP — N consecutive contradictions (agent claims success, engine disagrees)
 *   3. STUCK_LOOP — N consecutive identical failures of any class
 *   4. COST_CEILING — cumulative cost exceeds threshold
 *   5. TIMEOUT_STUCK — N consecutive timeouts
 */
export function evaluateCircuitBreaker(
  history: IterationSnapshot[],
  config: CircuitBreakerConfig,
): EjectionResult | null {
  if (!config.enabled || history.length === 0) return null;

  // Rule 1: INFRA_STUCK — repeated identical infrastructure failures
  const infraRun = consecutiveTailRun(history, s => s.failureClass === "INFRA");
  if (infraRun >= config.maxConsecutiveInfra) {
    // Check they're actually identical (same fingerprint)
    const tail = history.slice(-infraRun);
    const fp = tail[0].stderrFingerprint;
    if (fp && tail.every(s => s.stderrFingerprint === fp)) {
      return {
        rule: "INFRA_STUCK",
        reason: `${infraRun} consecutive identical INFRA failures — likely a broken validation setup, not bad code`,
      };
    }
  }

  // Rule 2: CONTRADICTION_LOOP — agent keeps claiming success but engine disagrees
  const contradictionRun = consecutiveTailRun(history, s => s.contradiction);
  if (contradictionRun >= config.maxConsecutiveContradictions) {
    return {
      rule: "CONTRADICTION_LOOP",
      reason: `${contradictionRun} consecutive contradictions — agent claims success but validation keeps failing`,
    };
  }

  // Rule 3: STUCK_LOOP — identical failures regardless of class
  const lastFp = history[history.length - 1].stderrFingerprint;
  if (lastFp) {
    const identicalRun = consecutiveTailRun(history, s => s.stderrFingerprint === lastFp);
    if (identicalRun >= config.maxConsecutiveIdenticalFailures) {
      return {
        rule: "STUCK_LOOP",
        reason: `${identicalRun} consecutive identical failures (${history[history.length - 1].failureClass}) — no progress being made`,
      };
    }
  }

  // Rule 4: COST_CEILING — cumulative cost exceeded
  if (config.costCeilingUsd > 0) {
    const lastCost = history[history.length - 1].cumulativeCostUsd;
    if (lastCost >= config.costCeilingUsd) {
      return {
        rule: "COST_CEILING",
        reason: `Cumulative cost $${lastCost.toFixed(2)} exceeds ceiling $${config.costCeilingUsd.toFixed(2)}`,
      };
    }
  }

  // Rule 5: TIMEOUT_STUCK — repeated timeouts
  const timeoutRun = consecutiveTailRun(history, s => s.failureClass === "TIMEOUT");
  if (timeoutRun >= config.maxConsecutiveTimeouts) {
    return {
      rule: "TIMEOUT_STUCK",
      reason: `${timeoutRun} consecutive timeouts — task likely cannot complete within time limits`,
    };
  }

  return null;
}

export class TaskEngine {
  private workspace: string;
  private config: Record<string, any>;
  private defaults: Record<string, any>;
  private logLevel: string;
  private projectsDir: string;

  readonly inbox: string;
  readonly active: string;
  readonly completed: string;
  readonly failed: string;

  // Injected by coordinator
  outbound: OutboundCommsProvider[] = [];
  memory: MemoryProvider[] = [];
  hotMemory: MarkdownMemoryProvider | null = null;
  archiver: SessionArchiver | null = null;

  /** Hook executor — injected by coordinator to bridge plugins into engine internals. */
  hookExecutor: ((event: string, data: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null;

  private processing = new Set<string>();

  constructor(workspace: string, config: Record<string, any>) {
    this.workspace = workspace;
    this.config = config;
    this.defaults = config.taskDefaults || {};
    this.logLevel = (config.system?.logLevel || "INFO").toUpperCase();
    this.projectsDir = resolveProjectsDir(workspace, config as any);

    this.inbox = join(workspace, "tasks", "inbox");
    this.active = join(workspace, "tasks", "active");
    this.completed = join(workspace, "tasks", "completed");
    this.failed = join(workspace, "tasks", "failed");

    for (const d of [this.inbox, this.active, this.completed, this.failed]) {
      mkdirSync(d, { recursive: true });
    }
  }

  /** Count task files in each lifecycle directory. */
  stats(): { inbox: number; active: number; completed: number; failed: number } {
    const count = (dir: string): number => {
      try { return readdirSync(dir).filter(f => f.endsWith(".yaml") || f.endsWith(".json")).length; }
      catch { return 0; }
    };
    return {
      inbox: count(this.inbox),
      active: count(this.active),
      completed: count(this.completed),
      failed: count(this.failed),
    };
  }

  // ── Worktree Isolation ─────────────────────────────────────────────

  /**
   * Resolve the git repo root for a project directory.
   * Returns null if not a git repo.
   */
  private gitRoot(projectDir: string): string | null {
    try {
      return execSync("git rev-parse --show-toplevel", {
        cwd: projectDir, encoding: "utf-8", timeout: 5000,
      }).trim();
    } catch { return null; }
  }

  /**
   * Create a git worktree for a task. Returns the worktree path, or null
   * if worktree creation fails (task will run in-place as fallback).
   */
  private createWorktree(task: Task, projectDir: string): string | null {
    const root = this.gitRoot(projectDir);
    if (!root) {
      console.warn(`[engine] ${task.id} — not a git repo, skipping worktree isolation`);
      return null;
    }

    // Sanitize task ID for branch/directory name
    const safeName = task.id.replace(/[^a-zA-Z0-9._-]/g, "-");
    const branchName = `tasksmith/${safeName}`;
    const worktreeDir = join(root, ".claude", "worktrees", safeName);

    try {
      mkdirSync(join(root, ".claude", "worktrees"), { recursive: true });
      execSync(`git worktree add -b "${branchName}" "${worktreeDir}" HEAD`, {
        cwd: root, encoding: "utf-8", timeout: 30_000,
      });
      console.log(`[engine] ${task.id} — worktree created: ${worktreeDir} (branch: ${branchName})`);
      return worktreeDir;
    } catch (e: any) {
      // Branch may already exist from a previous run — try without -b
      try {
        execSync(`git worktree add "${worktreeDir}" "${branchName}"`, {
          cwd: root, encoding: "utf-8", timeout: 30_000,
        });
        console.log(`[engine] ${task.id} — worktree reused: ${worktreeDir} (branch: ${branchName})`);
        return worktreeDir;
      } catch {
        console.error(`[engine] ${task.id} — worktree creation failed: ${e.message}`);
        console.warn(`[engine] ${task.id} — running WITHOUT worktree isolation`);
        return null;
      }
    }
  }

  /**
   * Remove a worktree after task completion. Best-effort — won't fail the task.
   */
  private removeWorktree(worktreePath: string, taskId: string, projectDir?: string): void {
    try {
      // Must run from the git repo root — without cwd, git can't find the worktree
      const cwd = projectDir ? this.gitRoot(projectDir) ?? undefined : undefined;
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd, encoding: "utf-8", timeout: 30_000,
      });
      console.log(`[engine] ${taskId} — worktree removed: ${worktreePath}`);
    } catch (e: any) {
      console.warn(`[engine] ${taskId} — worktree cleanup failed: ${e.message}`);
    }
  }

  /**
   * Determine if worktree isolation should be used for this task.
   * Enabled when concurrency > 1, or when engine config enables it,
   * unless the task explicitly opts out via params.worktree = false.
   */
  private shouldUseWorktree(task: Task): boolean {
    // Task-level opt-out
    if (task.params.worktree === false || task.params.worktree === "false") return false;

    // Must have a project to isolate
    if (!task.project) return false;

    const engineCfg = this.config.engine || {};
    const concurrency = engineCfg.concurrency || 1;

    // Explicit engine config
    if (engineCfg.worktree?.enabled === true) return true;
    if (engineCfg.worktree?.enabled === false) return false;

    // Default: enable when concurrency > 1
    return concurrency > 1;
  }

  // ── Skill Resolution ─────────────────────────────────────────────

  /**
   * Resolve the SKILL.md content for a given template name.
   * Search order (first match wins):
   *   1. Project-level: <projectDir>/.tasksmith/.claude/skills/<template>/SKILL.md
   *   2. Workspace:     <workspace>/.claude/skills/<template>/SKILL.md
   *   3. Global:        ~/.tasksmith/.claude/skills/<template>/SKILL.md
   */
  private resolveSkill(template: string, project?: string): string | null {
    const candidates: string[] = [];

    // Project-level
    if (project) {
      candidates.push(join(this.projectsDir, project, ".tasksmith", ".claude", "skills", template, "SKILL.md"));
    }

    // Workspace
    candidates.push(join(this.workspace, ".claude", "skills", template, "SKILL.md"));

    // Global
    const globalTs = join(homedir(), ".tasksmith", ".claude", "skills", template, "SKILL.md");
    candidates.push(globalTs);

    for (const fp of candidates) {
      if (existsSync(fp)) {
        try {
          return readFileSync(fp, "utf-8");
        } catch { /* skip unreadable */ }
      }
    }
    return null;
  }

  // ── Context Assembly (Compiled Prompt Pattern) ─────────────────────

  async assembleContext(task: Task): Promise<string> {
    if (this.hookExecutor) {
      await this.hookExecutor("beforeContextAssembly", { task });
    }

    const parts: string[] = [];
    const dd = join(this.workspace, "directives");

    // Directive files
    const directives: [string, string][] = [
      ["SOUL.md", "soul"], ["USER.md", "user"],
      ["CONVENTIONS.md", "conventions"], ["GLOSSARY.md", "glossary"],
    ];
    for (const [file, tag] of directives) {
      const fp = join(dd, file);
      if (existsSync(fp)) {
        const c = readFileSync(fp, "utf-8").trim();
        if (c) parts.push(`<${tag}>\n${c}\n</${tag}>`);
      }
    }

    // Hot memory
    if (this.hotMemory) {
      const hot = this.hotMemory.getHotContext();
      if (hot) parts.push(`<memory>\n${hot}\n</memory>`);
    }

    // Project context
    if (task.project) {
      const pd = join(this.projectsDir, task.project);
      for (const [file, tag] of [["CLAUDE.md", "project_context"], ["TASKS.md", "project_backlog"]] as const) {
        const fp = join(pd, file);
        if (existsSync(fp)) parts.push(`<${tag}>\n${readFileSync(fp, "utf-8").trim()}\n</${tag}>`);
      }
    }

    // Skill/template injection: resolve the SKILL.md for task.template and inject
    // its content into the prompt. $ARGUMENTS is replaced with the task prompt.
    // Search order: project .tasksmith → workspace → global ~/.tasksmith (first match wins).
    const skillContent = this.resolveSkill(task.template, task.project);
    if (skillContent) {
      // Strip YAML frontmatter (---...---) and inject with $ARGUMENTS replaced
      const body = skillContent.replace(/^---[\s\S]*?---\s*/, "").trim();
      const injected = body.replace(/\$ARGUMENTS/g, task.prompt);
      parts.push(`<skill>\n${injected}\n</skill>`);
    } else {
      parts.push(task.prompt);
    }

    let prompt = parts.join("\n\n");

    if (this.hookExecutor) {
      const result = await this.hookExecutor("afterContextAssembly", { task, prompt });
      if (typeof result.prompt === "string") prompt = result.prompt;
    }

    return prompt;
  }

  // ── Claude Code Invocation ─────────────────────────────────────────

  private async invokeCC(prompt: string, task: Task, cwdOverride?: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ccProviders = this.config.models?.providers || [];
    const ccCfg = ccProviders.find((p: any) => p.provider === "claude_code")?.config || {};
    const engineCfg = this.config.engine || {};

    const args = ["-p", prompt, "--model", task.model, "--output-format", "json"];

    // Pass permission mode as a native Claude Code flag
    const mode = (task.params.permission_mode as string) || engineCfg.permissionMode || "supervised";
    if (mode === "yolo") {
      args.push("--dangerously-skip-permissions");
    } else if (mode === "autonomous") {
      args.push("--permission-mode", "acceptEdits");
    }

    const dd = join(this.workspace, "directives");
    if (existsSync(dd)) args.push("--add-dir", dd);

    // Skills discovery: --add-dir for workspace, global, and project-level dirs.
    // CC discovers .claude/skills/<name>/SKILL.md in each --add-dir path when
    // CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 is set.
    // Workspace root (may differ from global when --dir or TASKSMITH_DIR is used)
    if (existsSync(this.workspace)) args.push("--add-dir", this.workspace);
    // Global ~/.tasksmith (skip if same as workspace to avoid duplicate)
    const globalTs = join(homedir(), ".tasksmith");
    if (existsSync(globalTs) && resolve(globalTs) !== resolve(this.workspace)) {
      args.push("--add-dir", globalTs);
    }
    if (task.project) {
      const projectTs = join(this.projectsDir, task.project, ".tasksmith");
      if (existsSync(projectTs)) args.push("--add-dir", projectTs);
    }

    // cwdOverride (worktree) takes priority, then project dir, then undefined
    let cwd: string | undefined = cwdOverride;
    if (!cwd && task.project) {
      const pd = join(this.projectsDir, task.project);
      if (!existsSync(pd) && (task.template === "project-init" || task.template === "project_init")) {
        // Green field: create the project directory so Claude Code has a clean workspace
        mkdirSync(pd, { recursive: true });
        console.log(`[engine] Created new project directory: ${pd}`);
      }
      if (existsSync(pd)) cwd = pd;
    }

    const timeout = (this.defaults.timeoutMinutes || 30) * 60 * 1000;

    console.log(`[engine] CC invoke: mode=${mode} model=${task.model} project=${task.project || "none"}`);

    const spawnCwd = cwd && existsSync(cwd) ? cwd : undefined;

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const child = spawn("claude", args, {
        cwd: spawnCwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout);

      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");

      child.stdout.on("data", (data: string) => { stdout += data; });
      child.stderr.on("data", (data: string) => { stderr += data; });

      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (e.code === "ENOENT") {
          resolve({ ok: false, error: "Claude Code CLI not found. Is it installed and on PATH?" });
        } else {
          resolve({ ok: false, error: e.message });
        }
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ ok: false, error: "Task timed out" });
          return;
        }
        if (code === 0) {
          resolve({ ok: true, output: stdout });
        } else {
          resolve({ ok: false, error: stderr || stdout || "Unknown error" });
        }
      });
    });
  }

  // ── CC Output Parsing & Logging ──────────────────────────────────

  /**
   * Parse the JSON blob returned by `claude --output-format json`,
   * log a human-readable summary of cost/turns/duration/result,
   * and optionally write the full raw output to a per-iteration log file
   * when logLevel is DEBUG.
   */
  private logCCOutput(raw: string, task: Task, iteration: number): CCJsonResult | null {
    let parsed: CCJsonResult | null = null;
    try {
      parsed = JSON.parse(raw) as CCJsonResult;
    } catch {
      // Not valid JSON (e.g. stderr mixed in) — nothing to extract
      return null;
    }

    // Always log the summary line
    const turns = parsed.num_turns ?? "?";
    const cost = parsed.total_cost_usd != null ? `$${parsed.total_cost_usd.toFixed(4)}` : "?";
    const dur = parsed.duration_ms != null ? `${(parsed.duration_ms / 1000).toFixed(1)}s` : "?";
    console.log(`[engine] ${task.id} iter ${iteration}: turns=${turns} cost=${cost} duration=${dur}`);

    // Log Claude's result text (truncated for console readability)
    if (parsed.result) {
      const preview = parsed.result.length > 300
        ? parsed.result.slice(0, 300) + "..."
        : parsed.result;
      console.log(`[engine] ${task.id} iter ${iteration} result: ${preview}`);
    }

    // DEBUG: write full raw output to per-iteration log file
    if (this.logLevel === "DEBUG") {
      const logDir = join(this.workspace, "logs", task.id);
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, `iteration-${iteration}.json`);
      try {
        writeFileSync(logFile, raw);
        console.log(`[engine] DEBUG: full output written to ${logFile}`);
      } catch (e) {
        console.warn(`[engine] DEBUG: failed to write log: ${e}`);
      }
    }

    return parsed;
  }

  // ── Validation ─────────────────────────────────────────────────────

  /**
   * Classify a validation failure based on stderr/stdout content.
   * Returns a tag that helps operators distinguish infrastructure problems
   * from actual code issues.
   */
  private classifyFailure(stderr: string, stdout: string, exitCode: number): ValidationResult['failureClass'] {
    if (exitCode === -1) return "TIMEOUT";

    const combined = (stderr + stdout).toLowerCase();

    // INFRA: the validation harness itself is broken (missing binary, bad
    // command syntax, missing env var, permission denied, not found, etc.)
    const infraPatterns = [
      "no binary for",
      "command not found",
      "no such file or directory",
      "permission denied",
      "env variable",
      "chromium_bin",
      "chrome_bin",
      "enoent",
      "too many arguments",
      "source: not found",
      "nvm: not found",
      "node: not found",
      "npm: not found",
    ];
    if (infraPatterns.some(p => combined.includes(p))) return "INFRA";

    // BUILD: compilation/transpilation failed
    const buildPatterns = [
      "error ts",
      "compilation failed",
      "build failed",
      "cannot find module",
      "module not found",
      "syntax error",
      "syntaxerror",
      "type error",
      "typeerror:",
      "error ng",
      "failed to compile",
    ];
    if (buildPatterns.some(p => combined.includes(p))) return "BUILD";

    // TEST: tests ran but some failed
    const testPatterns = [
      "failed",
      "failing",
      "fail:",
      "failures:",
      "tests failed",
      "spec fail",
      "assertion",
      "expect(",
      "expected",
    ];
    if (testPatterns.some(p => combined.includes(p))) return "TEST";

    // Unknown — default to INFRA since the command did fail
    return "INFRA";
  }

  private validate(task: Task, cwdOverride?: string): ValidationResult {
    let cmd = task.params.validation_command as string | undefined;
    if (!cmd) return { passed: true, output: "", exitCode: 0, stderrHead: "", command: "", failureClass: "NONE" };

    let cwd: string | undefined = cwdOverride;
    if (!cwd && task.project) {
      const pd = join(this.projectsDir, task.project);
      if (existsSync(pd)) cwd = pd;
    }

    // When running in a worktree, rewrite any absolute `cd /project/path` in
    // the validation command to target the worktree instead.  Without this,
    // validation tests the unchanged main repo rather than Claude's changes.
    if (cwdOverride && task.project) {
      const pd = join(this.projectsDir, task.project);
      if (existsSync(pd)) {
        const realProjectPath = realpathSync(pd);
        if (cmd.includes(realProjectPath)) {
          const rewritten = cmd.replace(realProjectPath, cwdOverride);
          console.log(`[engine] [${task.id}] Validation cmd rewritten for worktree: ${realProjectPath} → ${cwdOverride}`);
          cmd = rewritten;
        }
      }
    }

    try {
      const result = spawnSync("bash", ["-c", cmd], {
        cwd: cwd && existsSync(cwd) ? cwd : undefined,
        timeout: 300_000,
        encoding: "utf-8",
      });

      const stdout = result.stdout || "";
      const stderr = result.stderr || "";
      const exitCode = result.status ?? 1;
      const passed = exitCode === 0;
      const stderrHead = stderr.split("\n").filter(l => l.trim()).slice(0, 10).join("\n");

      return {
        passed,
        output: (stdout + stderr).slice(0, 5000),
        exitCode,
        stderrHead,
        command: cmd,
        failureClass: passed ? "NONE" : this.classifyFailure(stderr, stdout, exitCode),
      };
    } catch {
      return { passed: false, output: "Validation timed out", exitCode: -1, stderrHead: "", command: cmd, failureClass: "TIMEOUT" };
    }
  }

  // ── Smart Model Routing ──────────────────────────────────────────────

  /**
   * Model escalation tiers. On failure, escalate to the next tier.
   * Explicit user model choice (not "auto") disables escalation.
   */
  private static readonly MODEL_TIERS = ["haiku", "sonnet", "opus"];

  /**
   * Default model for each template when model is "auto".
   * Templates not listed default to "sonnet".
   */
  private static readonly TEMPLATE_MODEL_MAP: Record<string, string> = {
    "heartbeat":    "haiku",
    "code-review":  "haiku",
    "code_review":  "haiku",
    "doc-gen":      "haiku",
    "doc_gen":      "haiku",
    "research":     "sonnet",
    "ralph-loop":   "sonnet",
    "ralph_loop":   "sonnet",
    "bug-hunt":     "sonnet",
    "bug_hunt":     "sonnet",
    "project-init": "opus",
    "project_init": "opus",
  };

  /**
   * Resolve the model for a given iteration.
   *
   * When task.model is "auto":
   *   1. Pick initial model based on template type
   *   2. On failure (iteration > 1), escalate to next tier
   *   3. Consider prompt length as a complexity signal
   *
   * When task.model is explicit (e.g. "sonnet"), use it as-is.
   *
   * @returns The resolved model string and whether routing was applied
   */
  private resolveModel(task: Task, iteration: number, hadFailure: boolean): { model: string; routed: boolean } {
    const requestedModel = task.model;

    // Explicit model — no routing
    if (requestedModel !== "auto") {
      return { model: requestedModel, routed: false };
    }

    // Auto-routing: start with template-based default
    let baseModel = TaskEngine.TEMPLATE_MODEL_MAP[task.template] || "sonnet";

    // Complexity signal: very long prompts suggest complex tasks → bump up
    if (task.prompt.length > 5000 && baseModel === "haiku") {
      baseModel = "sonnet";
    }

    // Escalation on failure: move up a tier for each failed iteration
    if (hadFailure && iteration > 1) {
      const currentTier = TaskEngine.MODEL_TIERS.indexOf(baseModel);
      // Escalate by the number of failed iterations (capped at opus)
      const escalatedTier = Math.min(currentTier + (iteration - 1), TaskEngine.MODEL_TIERS.length - 1);
      const escalatedModel = TaskEngine.MODEL_TIERS[escalatedTier];
      if (escalatedModel !== baseModel) {
        console.log(`[engine] ${task.id} model escalation: ${baseModel} → ${escalatedModel} (iteration ${iteration})`);
        return { model: escalatedModel, routed: true };
      }
    }

    return { model: baseModel, routed: true };
  }

  // ── Task Execution ─────────────────────────────────────────────────

  async execute(task: Task, cwdOverride?: string): Promise<void> {
    task.status = "active";
    task.startedAt = new Date().toISOString();
    this.processing.add(task.id);

    // Worktree isolation: create if appropriate and no explicit cwdOverride
    let worktreePath: string | null = null;
    const projectDir = task.project ? join(this.projectsDir, task.project) : null;
    if (!cwdOverride && this.shouldUseWorktree(task)) {
      if (projectDir && existsSync(projectDir)) {
        worktreePath = this.createWorktree(task, projectDir);
        if (worktreePath) cwdOverride = worktreePath;
      }
    }

    // Resolve initial model
    const { model: initialModel, routed } = this.resolveModel(task, 1, false);
    if (routed) {
      console.log(`[engine] ${task.id} model routed: ${task.model} → ${initialModel} (template: ${task.template})`);
    }

    console.log(`[engine] Executing ${task.id}: template=${task.template} model=${initialModel}${cwdOverride ? ` cwd=${cwdOverride}` : ""}`);

    const tlog = new TaskLogger(this.workspace, task.id);
    tlog.taskStart(task);

    try {
      const isRalph = task.template === "ralph-loop" || Boolean(task.params.validation_command);
      const maxIter = isRalph ? task.maxIterations : 1;
      let lastErr = "";
      let lastValidation: ValidationResult | null = null;
      let contradictionDetected = false;
      let ejection: EjectionResult | null = null;

      // Resume support: pick up from last completed iteration
      const resumeFrom = task.iterations > 0 ? task.iterations + 1 : 1;
      let totalCost = (task as any)._checkpointCost ?? 0;
      if (resumeFrom > 1) {
        console.log(`[engine] ${task.id} resuming from iteration ${resumeFrom} (${task.iterations} completed, cost so far: $${totalCost.toFixed(4)})`);
        tlog.taskResume(task.id, resumeFrom, totalCost);
      }

      // Circuit breaker: merge defaults < config < task-level overrides
      const cbDefaults: CircuitBreakerConfig = {
        enabled: true, maxConsecutiveInfra: 2, maxConsecutiveContradictions: 3,
        maxConsecutiveIdenticalFailures: 3, maxConsecutiveTimeouts: 2, costCeilingUsd: 0,
      };
      const cbConfig: CircuitBreakerConfig = {
        ...cbDefaults,
        ...(this.defaults.circuitBreaker || {}),
        ...(task.params.circuit_breaker as Partial<CircuitBreakerConfig> || {}),
      };
      const cbHistory: IterationSnapshot[] = [];

      for (let i = resumeFrom; i <= maxIter; i++) {
        task.iterations = i;

        // Resolve model for this iteration (may escalate after failures)
        const { model: iterModel } = this.resolveModel(task, i, lastErr !== "");
        task.model = iterModel;
        tlog.iterStart(task.id, i, iterModel);

        let prompt = await this.assembleContext(task);

        if (lastErr) {
          prompt += `\n\n<previous_error>\nIteration ${i - 1} failed:\n${lastErr}\nFix the issues and try again.\n</previous_error>`;
        }

        const result = await this.invokeCC(prompt, task, cwdOverride);

        // Parse and log CC output regardless of success/failure
        const ccOutput = this.logCCOutput(
          result.output || result.error || "",
          task, i,
        );

        // Accumulate cost across iterations
        if (ccOutput?.total_cost_usd) totalCost += ccOutput.total_cost_usd;
        tlog.ccComplete(task.id, i, ccOutput);

        // Rate limit detection: pause and retry without counting the iteration
        const rateLimit = detectRateLimit(ccOutput);
        if (rateLimit.isRateLimited) {
          const resumeStr = rateLimit.resetTime
            ? rateLimit.resetTime.toLocaleTimeString()
            : `${Math.round(rateLimit.sleepMs / 60000)}min`;
          console.warn(`[engine] ${task.id} rate limited — pausing until ${resumeStr}`);
          tlog.rateLimited(task.id, i, rateLimit.sleepMs);
          await this.flushMemory(task, `Rate limited at iteration ${i}. Pausing until ${resumeStr}`);
          await sleep(rateLimit.sleepMs / 1000);
          console.log(`[engine] ${task.id} resuming after rate limit pause`);
          i--; // Retry the same iteration
          continue;
        }

        if (!result.ok) {
          lastErr = result.error || "Unknown error";
          // Use parsed result text if available (more informative than raw JSON)
          if (ccOutput?.result) lastErr = ccOutput.result;
          console.warn(`[engine] ${task.id} iteration ${i} failed: ${lastErr.slice(0, 200)}`);
          tlog.iterEnd(task.id, i, false, "CC_ERROR", totalCost);
          if (i < maxIter) {
            this.checkpoint(task, totalCost);
            await this.flushMemory(task, `Iteration ${i} error: ${lastErr.slice(0, 500)}`);
            await sleep((task.params.cooldown_seconds as number) || 5);
            continue;
          }
          break;
        }

        if (isRalph) {
          const v = this.validate(task, cwdOverride);
          if (v.passed) {
            tlog.validation(task.id, i, v, false);
            tlog.iterEnd(task.id, i, true, "NONE", totalCost);
            task.result = `Passed after ${i} iteration(s) [model: ${iterModel}]`;
            task.status = "completed";
            console.log(`[engine] ${task.id} iteration ${i}: ✓ validation passed`);
            break;
          }

          // ── Detailed failure logging (operator-facing) ──────────────
          lastErr = v.output;
          lastValidation = v;
          const tag = `[${v.failureClass}]`;
          console.log(`[engine] ${task.id} iteration ${i}: ${tag} validation failed (exit ${v.exitCode})`);

          // Show the first few lines of stderr — this is the #1 diagnostic signal
          if (v.stderrHead) {
            const lines = v.stderrHead.split("\n").slice(0, 5);
            for (const line of lines) {
              console.log(`[engine] ${task.id}   stderr> ${line}`);
            }
          }

          // Contradiction detection: agent claims success but engine disagrees.
          // This typically means an infrastructure problem, not bad code.
          const agentClaimedSuccess = ccOutput?.result
            ? /\ball\b.*\bpass/i.test(ccOutput.result) || /\bsuccess/i.test(ccOutput.result) || /\bbuilt successfully/i.test(ccOutput.result)
            : false;
          if (agentClaimedSuccess) {
            contradictionDetected = true;
            console.warn(`[engine] ${task.id}   ⚠ CONTRADICTION: Agent reported success but engine validation failed`);
            if (v.failureClass === "INFRA") {
              console.warn(`[engine] ${task.id}   ⚠ Likely infrastructure issue, not bad code — consider fixing validation setup`);
            }
          }

          tlog.validation(task.id, i, v, agentClaimedSuccess);

          // Circuit breaker: record this iteration and check for ejection
          cbHistory.push({
            iteration: i,
            failureClass: v.failureClass,
            exitCode: v.exitCode,
            stderrFingerprint: fingerprint(v.stderrHead),
            contradiction: agentClaimedSuccess,
            cumulativeCostUsd: totalCost,
          });

          ejection = evaluateCircuitBreaker(cbHistory, cbConfig);
          if (ejection) {
            console.error(`[engine] ${task.id} ⛔ CIRCUIT BREAKER: ${ejection.rule} — ${ejection.reason}`);
            tlog.ejected(task.id, i, ejection.rule, ejection.reason);
            tlog.iterEnd(task.id, i, false, v.failureClass, totalCost);
            task.error = `Early ejection (${ejection.rule}): ${ejection.reason}`;
            task.status = "failed";
            break;
          }

          tlog.iterEnd(task.id, i, false, v.failureClass, totalCost);

          if (i < maxIter) {
            this.checkpoint(task, totalCost);
            await this.flushMemory(task, `[${v.failureClass}] Validation failed #${i} (exit ${v.exitCode}): ${v.stderrHead.slice(0, 300) || lastErr.slice(0, 300)}`);
            await sleep((task.params.cooldown_seconds as number) || 5);
          }
        } else {
          tlog.iterEnd(task.id, i, true, "NONE", totalCost);
          task.result = "Completed";
          task.status = "completed";
          break;
        }
      }

      if (task.status !== "completed") {
        task.status = "failed";
        task.error = `Failed after ${maxIter} iterations. Last: ${lastErr.slice(0, 1000)}`;
      }

      // Enrich task with diagnostics for post-mortem review.
      // Use finalValidation so completed tasks show NONE instead of stale failure data.
      const finalValidation = task.status === "completed"
        ? { failureClass: "NONE" as const, exitCode: 0, stderrHead: "" }
        : lastValidation;

      const diagnostics = {
        total_cost_usd: Math.round(totalCost * 10000) / 10000,
        iterations_used: task.iterations,
        failure_class: finalValidation?.failureClass || "NONE",
        last_validation_exit_code: finalValidation?.exitCode ?? null,
        last_validation_stderr_head: finalValidation?.stderrHead?.slice(0, 500) || null,
        contradiction_detected: contradictionDetected,
        ejected: ejection !== null,
        ejection_rule: ejection?.rule || null,
        ejection_iteration: ejection ? task.iterations : null,
        worktree: worktreePath || null,
      };
      (task as any).diagnostics = diagnostics;
      tlog.taskEnd(task.id, task.status, diagnostics);
    } catch (e: any) {
      task.status = "failed";
      task.error = e.message;
      console.error(`[engine] ${task.id} exception:`, e);
      tlog.taskEnd(task.id, "failed", { error: e.message });
    } finally {
      task.completedAt = new Date().toISOString();
      this.processing.delete(task.id);
      await this.finalize(task);
      await this.postMemory(task);
      await this.notify(task);

      // Clean up worktree after task is fully complete
      if (worktreePath) {
        this.removeWorktree(worktreePath, task.id, projectDir ?? undefined);
      }
    }
  }

  // ── Memory ─────────────────────────────────────────────────────────

  private async flushMemory(task: Task, content: string): Promise<void> {
    const entry: MemoryEntry = { content, source: task.id, category: "error", importance: 0.6, timestamp: new Date() };
    for (const p of this.memory) {
      try { await p.store(entry); } catch (e) { console.error(`[memory:${p.name}] flush failed:`, e); }
    }
    if (this.hookExecutor) {
      await this.hookExecutor("onMemoryFlush", { entry: { content: entry.content, id: task.id, type: entry.category } });
    }
  }

  private async postMemory(task: Task): Promise<void> {
    const ok = task.status === "completed";
    let summary = `Task ${task.id} (${task.template}) ${ok ? "completed" : "failed"}. Project: ${task.project || "none"}. Iterations: ${task.iterations}. Prompt: ${task.prompt.slice(0, 200)}`;
    if (task.error) summary += ` Error: ${task.error.slice(0, 200)}`;

    const entry: MemoryEntry = { content: summary, source: task.id, category: "task_result", importance: ok ? 0.7 : 0.8, timestamp: new Date() };
    for (const p of this.memory) {
      try { await p.store(entry); } catch (e) { console.error(`[memory:${p.name}] post failed:`, e); }
    }
    if (this.hookExecutor) {
      await this.hookExecutor("onMemoryFlush", { entry: { content: entry.content, id: task.id, type: entry.category } });
    }
  }

  // ── Checkpointing & Finalization ────────────────────────────────────

  /**
   * Write iteration checkpoint to active task YAML.
   * On restart, the engine reads this to resume from the last completed iteration.
   */
  private checkpoint(task: Task, cumulativeCost: number): void {
    const activeFile = join(this.active, `${task.id}.yaml`);
    if (!existsSync(activeFile)) return;
    try {
      (task as any)._checkpointCost = Math.round(cumulativeCost * 10000) / 10000;
      writeFileSync(activeFile, taskToYaml(task));
    } catch {
      // Non-fatal — checkpoint is best-effort
    }
  }

  private async finalize(task: Task): Promise<void> {
    const destDir = task.status === "completed" ? this.completed : this.failed;
    const taskData = taskToYaml(task);
    writeFileSync(join(destDir, `${task.id}.yaml`), taskData);

    const activeFile = join(this.active, `${task.id}.yaml`);
    if (existsSync(activeFile)) unlinkSync(activeFile);

    if (this.archiver) {
      await this.archiver.archive(task.id, task as any);
    }
  }

  private async notify(task: Task): Promise<void> {
    const ok = task.status === "completed";
    const diag = (task as any).diagnostics as Record<string, any> | undefined;

    // Build a rich notification body with cost, diagnostics, and ejection details
    const lines: string[] = [];
    lines.push(ok ? task.result : (task.error?.slice(0, 500) || "Unknown error"));
    lines.push(`Project: ${task.project || "N/A"} | Model: ${task.model} | Iterations: ${task.iterations}`);

    if (diag) {
      if (diag.total_cost_usd > 0) {
        lines.push(`Cost: $${diag.total_cost_usd.toFixed(4)}`);
      }
      if (!ok && diag.failure_class && diag.failure_class !== "NONE") {
        lines.push(`Failure class: ${diag.failure_class}`);
      }
      if (diag.ejected) {
        lines.push(`Circuit breaker: ${diag.ejection_rule} (iteration ${diag.ejection_iteration})`);
      }
      if (diag.contradiction_detected) {
        lines.push(`Warning: Agent claimed success but validation disagreed`);
      }
    }

    const n: Notification = {
      title: `${ok ? "✅" : "❌"} ${task.template}: ${ok ? "Done" : "Failed"}`,
      body: lines.join("\n"),
      priority: (ok ? "normal" : "high") as Priority,
      taskId: task.id,
      metadata: diag ? { ...diag } : undefined,
    };
    for (const p of this.outbound) {
      try { await p.send(n); } catch (e) { console.error(`[notify:${p.name}]`, e); }
    }
  }

  // ── Task Parsing ───────────────────────────────────────────────────

  parseTask(content: string, sourceFile = ""): Task {
    const data = parseTaskFile(content, sourceFile || "task.yaml");
    if (!data || typeof data !== "object") throw new Error("Task must be a YAML or JSON mapping");

    const now = new Date().toISOString();
    const id = data.id || `task-${now.slice(0, 19).replace(/[T:]/g, "").replace(/-/g, "")}-${uuidv4().slice(0, 6)}`;

    return {
      id,
      template: data.template || "ralph-loop",
      prompt: data.prompt || "",
      project: data.project || "",
      params: data.params || {},
      model: data.model || this.defaults.model || "sonnet",
      priority: data.priority || this.defaults.priority || "normal",
      maxIterations: data.max_iterations ?? data.maxIterations ?? this.defaults.maxIterations ?? 5,
      notify: data.notify || ["all"],
      status: data.status || "pending",
      createdAt: data.created_at || data.createdAt || now,
      startedAt: data.started_at || data.startedAt || "",
      completedAt: data.completed_at || data.completedAt || "",
      result: data.result || "",
      error: data.error || "",
      iterations: data.iterations ?? 0,
      sourceFile,
      dependsOn: data.depends_on || data.dependsOn || undefined,
      dagId: data.dag_id || data.dagId || undefined,
      // Checkpoint cost — preserved across restarts for iteration resume
      ...(data._checkpoint_cost != null ? { _checkpointCost: data._checkpoint_cost } : {}),
    } as Task;
  }

  // ── Inbox Processing ───────────────────────────────────────────────

  async processFile(filePath: string): Promise<void> {
    return this.processFileAndExecute(filePath);
  }

  /** Parse and move to active, then execute (legacy sequential path) */
  private async processFileAndExecute(filePath: string): Promise<void> {
    const task = this.pickupTask(filePath);
    if (!task) return;
    await this.execute(task);
  }

  /** Parse task from file, move to active dir. Returns task or null on error. */
  pickupTask(filePath: string): Task | null {
    const fileName = filePath.split("/").pop() || filePath;
    try {
      const content = readFileSync(filePath, "utf-8");
      const task = this.parseTask(content, filePath);

      // Atomic claim: rename moves the file out of inbox.
      // If this fails with ENOENT, the file watcher already claimed it — skip.
      const activeFile = join(this.active, `${task.id}.yaml`);
      renameSync(filePath, activeFile);

      console.log(`[engine] Picked up ${task.id}`);
      return task;
    } catch (e: any) {
      // ENOENT = file was already claimed by the watcher (normal race, not an error)
      if (e.code === "ENOENT") return null;
      console.error(`[engine] Failed to process ${fileName}: ${e.message}`);
      try { renameSync(filePath, join(this.failed, fileName)); } catch { /* ignore */ }
      return null;
    }
  }

  /** Scan inbox and return all pending tasks (for pool-based execution) */
  pickupAll(): Task[] {
    const files = readdirSync(this.inbox)
      .filter(f => isTaskFile(f))
      .filter(f => !f.startsWith("."))
      .sort();

    const tasks: Task[] = [];
    for (const f of files) {
      const task = this.pickupTask(join(this.inbox, f));
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async scanInbox(): Promise<void> {
    const files = readdirSync(this.inbox)
      .filter(f => isTaskFile(f))
      .filter(f => !f.startsWith("."))
      .sort();

    for (const f of files) {
      await this.processFile(join(this.inbox, f));
    }
  }

  /**
   * Resume orphaned tasks from active/ directory on engine restart.
   * Tasks left in active/ after a crash or restart are parsed and returned
   * for re-execution. They retain their iteration count so the Ralph Loop
   * resumes from the last checkpoint instead of starting over.
   */
  resumeActive(): Task[] {
    const files = readdirSync(this.active)
      .filter(f => isTaskFile(f))
      .filter(f => !f.startsWith("."))
      .sort();

    const tasks: Task[] = [];
    for (const f of files) {
      try {
        const filePath = join(this.active, f);
        const content = readFileSync(filePath, "utf-8");
        const task = this.parseTask(content, filePath);
        // Already in active/ — no rename needed
        console.log(`[engine] Resuming orphaned task ${task.id} (iterations: ${task.iterations}, status: ${task.status})`);
        tasks.push(task);
      } catch (e: any) {
        console.warn(`[engine] Failed to resume ${f}: ${e.message}`);
      }
    }
    return tasks;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function taskToYaml(task: Task): string {
  const data: Record<string, any> = {};
  for (const [k, v] of Object.entries(task)) {
    if (v !== "" && v !== 0 && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) {
      // Convert camelCase to snake_case for YAML
      const key = k.replace(/([A-Z])/g, "_$1").toLowerCase();
      data[key] = v;
    }
  }
  return yaml.dump(data, { lineWidth: 120 });
}

function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}
