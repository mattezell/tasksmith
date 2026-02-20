/**
 * Task Engine — the heart of TaskSmith.
 *
 * Watches inbox, assembles compiled prompts, invokes Claude Code CLI,
 * manages Ralph Loop, coordinates memory and notifications.
 */

import { execSync, execFileSync, spawnSync, spawn } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  renameSync, unlinkSync, readdirSync,
} from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import yaml from "js-yaml";
import type {
  Task, TaskStatus, Priority, Notification, MemoryEntry,
  OutboundCommsProvider, MemoryProvider, TaskSmithConfig,
} from "./types.js";
import type { MarkdownMemoryProvider } from "./providers/memory/providers.js";
import type { PluginManager } from "./plugins.js";
import { resolveTemplate, isTaskFile, parseTaskFile } from "./config.js";
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

export class TaskEngine {
  private workspace: string;
  private config: Record<string, any>;
  private defaults: Record<string, any>;
  private logLevel: string;

  readonly inbox: string;
  readonly active: string;
  readonly completed: string;
  readonly failed: string;

  // Injected by coordinator
  outbound: OutboundCommsProvider[] = [];
  memory: MemoryProvider[] = [];
  hotMemory: MarkdownMemoryProvider | null = null;
  archiver: SessionArchiver | null = null;

  /**
   * Injected by coordinator after plugins are activated.
   * Used to run command wrappers (e.g. sandbox plugin) before spawning claude.
   */
  pluginManager: PluginManager | null = null;

  private processing = new Set<string>();

  constructor(workspace: string, config: Record<string, any>) {
    this.workspace = workspace;
    this.config = config;
    this.defaults = config.taskDefaults || {};
    this.logLevel = (config.system?.logLevel || "INFO").toUpperCase();

    this.inbox = join(workspace, "tasks", "inbox");
    this.active = join(workspace, "tasks", "active");
    this.completed = join(workspace, "tasks", "completed");
    this.failed = join(workspace, "tasks", "failed");

    for (const d of [this.inbox, this.active, this.completed, this.failed]) {
      mkdirSync(d, { recursive: true });
    }
  }

  // ── Context Assembly (Compiled Prompt Pattern) ─────────────────────

  assembleContext(task: Task): string {
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
      const pd = join(this.workspace, "projects", task.project);
      for (const [file, tag] of [["CLAUDE.md", "project_context"], ["TASKS.md", "project_backlog"]] as const) {
        const fp = join(pd, file);
        if (existsSync(fp)) parts.push(`<${tag}>\n${readFileSync(fp, "utf-8").trim()}\n</${tag}>`);
      }
    }

    // Template prompt (searches project-local, workspace, global, built-in)
    const templateDir = resolveTemplate(task.template, this.workspace, this.config as any);

    if (templateDir) {
      const promptFile = join(templateDir, "PROMPT.md");
      let tp = readFileSync(promptFile, "utf-8");
      tp = tp.replace(/\{\{prompt\}\}/g, task.prompt);
      tp = tp.replace(/\{\{project\}\}/g, task.project);
      for (const [k, v] of Object.entries(task.params)) {
        tp = tp.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
      }
      parts.push(tp);
    } else {
      parts.push(task.prompt);
    }

    return parts.join("\n\n");
  }

  // ── Claude Code Invocation ─────────────────────────────────────────

  private async invokeCC(prompt: string, task: Task, cwdOverride?: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ccProviders = this.config.models?.providers || [];
    const ccCfg = ccProviders.find((p: any) => p.provider === "claude_code")?.config || {};
    const engineCfg = this.config.engine || {};

    const args = ["-p", prompt, "--model", task.model, "--output-format", "json"];

    // Resolve permission mode: task-level override > engine config > default
    const mode = (task.params.permission_mode as string) || engineCfg.permissionMode || "supervised";

    if (mode === "yolo") {
      args.push("--dangerously-skip-permissions");
      // --disallowedTools still works in bypass mode
      const denyList = this.buildDenyList(engineCfg, task);
      for (const t of denyList) args.push("--disallowedTools", t);
    } else if (mode === "autonomous") {
      args.push("--permission-mode", "acceptEdits");
      const allowList = this.buildAllowList(engineCfg, task);
      for (const t of allowList) args.push("--allowedTools", t);
      const denyList = this.buildDenyList(engineCfg, task);
      for (const t of denyList) args.push("--disallowedTools", t);
    } else {
      // supervised: legacy behavior — use defaultAllowedTools from claude_code provider config
      const tools: string[] = ccCfg.defaultAllowedTools || ["Write", "Read", "Edit", "Bash", "Task"];
      for (const t of tools) args.push("--allowedTools", t);
    }

    const dd = join(this.workspace, "directives");
    if (existsSync(dd)) args.push("--add-dir", dd);

    // cwdOverride (worktree) takes priority, then project dir, then undefined
    let cwd: string | undefined = cwdOverride;
    if (!cwd && task.project) {
      const pd = join(this.workspace, "projects", task.project);
      if (!existsSync(pd) && (task.template === "project-init" || task.template === "project_init")) {
        // Green field: create the project directory so Claude Code has a clean workspace
        mkdirSync(pd, { recursive: true });
        console.log(`[engine] Created new project directory: ${pd}`);
      }
      if (existsSync(pd)) cwd = pd;
    }

    const timeout = (this.defaults.timeoutMinutes || 30) * 60 * 1000;

    // Run through plugin command wrappers (e.g. sandbox plugin prepends `srt`).
    // Only use shell: true when a wrapper actually transformed the command —
    // otherwise use array-style spawn to avoid shell metacharacter interpretation
    // of prompt content.
    let wrappedCommand: string | null = null;
    if (this.pluginManager) {
      const baseCommand = ["claude", ...args].join(" ");
      const transformed = await this.pluginManager.applyCommandWrappers(baseCommand, task);
      if (transformed !== baseCommand) wrappedCommand = transformed;
    }

    console.log(`[engine] CC invoke: mode=${mode} model=${task.model} project=${task.project || "none"}`);

    const spawnCwd = cwd && existsSync(cwd) ? cwd : undefined;

    // Use async spawn to avoid blocking the event loop.
    // spawnSync blocks the entire Node.js process, which prevents the
    // scan interval, file watchers, and other async tasks from running.
    // With async spawn, multiple Claude invocations can run concurrently.
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const cmd = wrappedCommand || "claude";
      const cmdArgs = wrappedCommand ? [] : args;
      const useShell = Boolean(wrappedCommand);

      const child = spawn(cmd, cmdArgs, {
        cwd: spawnCwd,
        shell: useShell,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CLAUDECODE: undefined },
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

  // ── Permission List Builders ───────────────────────────────────────

  private buildAllowList(engineCfg: Record<string, any>, task: Task): string[] {
    const base: string[] = engineCfg.permissions?.allow || [];
    const taskAllow: string[] = (task.params.allowed_tools as string[]) || [];

    // Auto-allow the validation command if one is set
    const valCmd = task.params.validation_command as string | undefined;
    const valAllow: string[] = [];
    if (valCmd) {
      // Extract the base command (first word) and allow it with wildcard
      const baseCmd = valCmd.trim().split(/\s+/)[0];
      valAllow.push(`Bash(${baseCmd} *)`);
    }

    // Deduplicate
    return [...new Set([...base, ...taskAllow, ...valAllow])];
  }

  private buildDenyList(engineCfg: Record<string, any>, task: Task): string[] {
    const base: string[] = engineCfg.permissions?.deny || [];
    const taskDeny: string[] = (task.params.disallowed_tools as string[]) || [];
    return [...new Set([...base, ...taskDeny])];
  }

  // ── Validation ─────────────────────────────────────────────────────

  private validate(task: Task, cwdOverride?: string): { passed: boolean; output: string } {
    const cmd = task.params.validation_command as string | undefined;
    if (!cmd) return { passed: true, output: "" };

    let cwd: string | undefined = cwdOverride;
    if (!cwd && task.project) {
      const pd = join(this.workspace, "projects", task.project);
      if (existsSync(pd)) cwd = pd;
    }

    try {
      const result = spawnSync("sh", ["-c", cmd], {
        cwd: cwd && existsSync(cwd) ? cwd : undefined,
        timeout: 300_000,
        encoding: "utf-8",
      });
      return { passed: result.status === 0, output: ((result.stdout || "") + (result.stderr || "")).slice(0, 5000) };
    } catch {
      return { passed: false, output: "Validation timed out" };
    }
  }

  // ── Task Execution ─────────────────────────────────────────────────

  async execute(task: Task, cwdOverride?: string): Promise<void> {
    task.status = "active";
    task.startedAt = new Date().toISOString();
    this.processing.add(task.id);

    console.log(`[engine] Executing ${task.id}: template=${task.template} model=${task.model}${cwdOverride ? ` cwd=${cwdOverride}` : ""}`);

    try {
      const isRalph = task.template === "ralph-loop" || Boolean(task.params.validation_command);
      const maxIter = isRalph ? task.maxIterations : 1;
      let lastErr = "";

      for (let i = 1; i <= maxIter; i++) {
        task.iterations = i;
        let prompt = this.assembleContext(task);

        if (lastErr) {
          prompt += `\n\n<previous_error>\nIteration ${i - 1} failed:\n${lastErr}\nFix the issues and try again.\n</previous_error>`;
        }

        const result = await this.invokeCC(prompt, task, cwdOverride);

        // Parse and log CC output regardless of success/failure
        const ccOutput = this.logCCOutput(
          result.output || result.error || "",
          task, i,
        );

        if (!result.ok) {
          lastErr = result.error || "Unknown error";
          // Use parsed result text if available (more informative than raw JSON)
          if (ccOutput?.result) lastErr = ccOutput.result;
          console.warn(`[engine] ${task.id} iteration ${i} failed: ${lastErr.slice(0, 200)}`);
          if (i < maxIter) {
            await this.flushMemory(task, `Iteration ${i} error: ${lastErr.slice(0, 500)}`);
            await sleep((task.params.cooldown_seconds as number) || 5);
            continue;
          }
          break;
        }

        if (isRalph) {
          const v = this.validate(task, cwdOverride);
          if (v.passed) {
            task.result = `Passed after ${i} iteration(s)`;
            task.status = "completed";
            break;
          }
          lastErr = v.output;
          console.log(`[engine] ${task.id} iteration ${i}: validation failed`);
          if (i < maxIter) {
            await this.flushMemory(task, `Validation failed #${i}: ${lastErr.slice(0, 500)}`);
            await sleep((task.params.cooldown_seconds as number) || 5);
          }
        } else {
          task.result = "Completed";
          task.status = "completed";
          break;
        }
      }

      if (task.status !== "completed") {
        task.status = "failed";
        task.error = `Failed after ${maxIter} iterations. Last: ${lastErr.slice(0, 1000)}`;
      }
    } catch (e: any) {
      task.status = "failed";
      task.error = e.message;
      console.error(`[engine] ${task.id} exception:`, e);
    } finally {
      task.completedAt = new Date().toISOString();
      this.processing.delete(task.id);
      await this.finalize(task);
      await this.postMemory(task);
      await this.notify(task);
    }
  }

  // ── Memory ─────────────────────────────────────────────────────────

  private async flushMemory(task: Task, content: string): Promise<void> {
    const entry: MemoryEntry = { content, source: task.id, category: "error", importance: 0.6, timestamp: new Date() };
    for (const p of this.memory) {
      try { await p.store(entry); } catch (e) { console.error(`[memory:${p.name}] flush failed:`, e); }
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
  }

  // ── Finalization ───────────────────────────────────────────────────

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
    const n: Notification = {
      title: `${ok ? "✅" : "❌"} ${task.template}: ${ok ? "Done" : "Failed"}`,
      body: `${ok ? task.result : task.error?.slice(0, 500)}\nProject: ${task.project || "N/A"} | Iterations: ${task.iterations}`,
      priority: (ok ? "normal" : "high") as Priority,
      taskId: task.id,
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
      status: "pending",
      createdAt: data.created_at || data.createdAt || now,
      startedAt: "",
      completedAt: "",
      result: "",
      error: "",
      iterations: 0,
      sourceFile,
    };
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

      // Move to active
      const activeFile = join(this.active, `${task.id}.yaml`);
      renameSync(filePath, activeFile);

      console.log(`[engine] Picked up ${task.id}`);
      return task;
    } catch (e: any) {
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
