/**
 * Coordinator — wires providers, engine, API, and listeners together.
 *
 * Single entry point for `tasksmith run`. Starts all enabled subsystems
 * concurrently and manages graceful shutdown.
 */

import { join, dirname } from "node:path";
import { writeFileSync, unlinkSync, mkdirSync, readdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import yaml from "js-yaml";
import chalk from "chalk";
import { v4 as uuidv4 } from "uuid";
import { scaffoldWorkspace, installBundledSkills } from "./config.js";
import { TaskEngine } from "./engine.js";
import { createAPIServer } from "./api.js";
import { OUTBOUND_REGISTRY, createInboundProvider } from "./providers/comms/providers.js";
import { MarkdownMemoryProvider, JSONLMemoryProvider, SessionArchiver, MEMORY_REGISTRY } from "./providers/memory/providers.js";
import { PluginManager } from "./plugins.js";
import { Scheduler } from "./scheduler.js";
import { WorkerPool } from "./pool.js";
import type {
  TaskSmithConfig, OutboundCommsProvider, InboundCommsProvider,
  MemoryProvider, InboundMessage, Task,
} from "./types.js";
import { sanitizeTask, trustLevel } from "./sanitize.js";
import { DAGManager } from "./dag.js";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

export class Coordinator {
  private workspace: string;
  private config: TaskSmithConfig;

  private engine!: TaskEngine;
  private outbound: OutboundCommsProvider[] = [];
  private inbound: InboundCommsProvider[] = [];
  private memory: MemoryProvider[] = [];
  private hotMemory: MarkdownMemoryProvider | null = null;
  private archiver: SessionArchiver | null = null;

  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private dashboardInterval: ReturnType<typeof setInterval> | null = null;
  private shutdownRequested = false;
  private pluginManager: PluginManager;
  private scheduler: Scheduler | null = null;
  private pool: WorkerPool | null = null;
  private dagManager: DAGManager;

  /** Pending DAG tasks: task ID → task data. Held until deps complete. */
  private dagPending = new Map<string, Task>();

  /** Pending approval tasks: task ID → { task, source, timeout handle }. */
  private approvalPending = new Map<string, { task: Task; source: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(workspace: string, config: TaskSmithConfig) {
    this.workspace = workspace;
    this.config = config;
    this.pluginManager = new PluginManager(workspace, config as any);
    this.dagManager = new DAGManager(workspace);
  }

  // ── Bootstrap ──────────────────────────────────────────────────

  private buildOutbound(): void {
    for (const entry of this.config.communication.outbound) {
      if (entry.enabled && entry.provider in OUTBOUND_REGISTRY) {
        const Cls = OUTBOUND_REGISTRY[entry.provider];
        this.outbound.push(new Cls(entry.config));
        console.log(`  ${chalk.green("✓")} Outbound: ${entry.provider}`);
      }
    }
  }

  private buildInbound(): void {
    const inboxPath = join(this.workspace, "tasks", "inbox");
    for (const entry of this.config.communication.inbound) {
      if (!entry.enabled) continue;
      if (entry.provider === "rest_api") continue; // Handled separately
      const provider = createInboundProvider(entry.provider, entry.config, inboxPath);
      if (provider) {
        this.inbound.push(provider);
        console.log(`  ${chalk.green("✓")} Inbound: ${entry.provider}`);
      }
    }
  }

  private buildMemory(): void {
    // Hot: always markdown
    const hotCfg = this.config.memory.hot.config;
    this.hotMemory = new MarkdownMemoryProvider(hotCfg, this.workspace);
    this.memory.push(this.hotMemory);

    // Warm: JSONL always on + enabled extras
    for (const entry of this.config.memory.warm) {
      if (entry.provider === "jsonl_logs") {
        this.memory.push(new JSONLMemoryProvider(entry.config, this.workspace));
      } else if (entry.enabled && entry.provider in MEMORY_REGISTRY) {
        const Cls = MEMORY_REGISTRY[entry.provider];
        this.memory.push(new Cls(entry.config, this.workspace));
      }
    }

    // Cold
    this.archiver = new SessionArchiver(this.config.memory.cold.config, this.workspace);
    this.archiver.initialize();

    console.log(`  ${chalk.green("✓")} Memory: ${this.memory.map(p => p.name).join(", ")}`);
  }

  private buildEngine(): void {
    this.engine = new TaskEngine(this.workspace, this.config as any);
    this.engine.outbound = this.outbound;
    this.engine.memory = this.memory;
    this.engine.hotMemory = this.hotMemory;
    this.engine.archiver = this.archiver;
    this.engine.hookExecutor = (event, data) =>
      this.pluginManager.executeHooks(event as any, data);
  }

  // ── Inbound Handler ────────────────────────────────────────────

  /**
   * Remove the original source file after handleInbound writes a normalized
   * copy. Prevents scanInbox from also picking up the original, which would
   * create a duplicate task.
   */
  private cleanupSourceFile(msg: InboundMessage): void {
    if (msg.source === "file_drop" && msg.metadata?.filePath) {
      try { unlinkSync(msg.metadata.filePath as string); } catch { /* already moved by scanInbox */ }
    }
  }

  // ── Approval Gates ─────────────────────────────────────────────

  /**
   * Check if a task matches any approval gate rules.
   * Returns the matched rule description, or null if no gate applies.
   */
  private requiresApproval(task: Task, source: string): string | null {
    const gates = (this.config as any).engine?.approvalGates;
    if (!gates?.enabled) return null;

    const rules = gates.requireApproval as Array<Record<string, unknown>> | undefined;
    if (!rules || rules.length === 0) return null;

    for (const rule of rules) {
      // Match by template
      if (rule.template) {
        const templates = Array.isArray(rule.template) ? rule.template : [rule.template];
        if (templates.includes(task.template)) return `template=${task.template}`;
      }

      // Match by inbound source
      if (rule.source) {
        const sources = Array.isArray(rule.source) ? rule.source : [rule.source];
        if (sources.includes(source)) return `source=${source}`;
      }

      // Match by task params (all specified keys must match)
      if (rule.params && typeof rule.params === "object") {
        const paramRules = rule.params as Record<string, unknown>;
        const allMatch = Object.entries(paramRules).every(
          ([k, v]) => task.params[k] === v
        );
        if (allMatch) return `params={${Object.keys(paramRules).join(",")}}`;
      }
    }

    return null;
  }

  /**
   * Park a task for approval. Sends notification and sets timeout.
   */
  private async parkForApproval(task: Task, source: string, matchedRule: string): Promise<void> {
    const gates = (this.config as any).engine?.approvalGates || {};
    const timeoutMin = (gates.timeoutMinutes as number) || 60;

    // Write to a pending_approval directory
    const approvalDir = join(this.workspace, "tasks", "pending_approval");
    mkdirSync(approvalDir, { recursive: true });
    writeFileSync(join(approvalDir, `${task.id}.yaml`), yaml.dump({ ...task, status: "pending_approval" }));

    // Set timeout
    const timer = setTimeout(() => {
      this.handleApprovalDecision(task.id, false, "timeout");
    }, timeoutMin * 60_000);
    timer.unref();

    this.approvalPending.set(task.id, { task, source, timer });

    // Notify operator
    const title = `⏳ Approval required: ${task.template} (${task.id})`;
    const body = [
      `Task requires approval (matched rule: ${matchedRule})`,
      `Prompt: ${task.prompt.slice(0, 300)}`,
      `Project: ${task.project || "N/A"} | Model: ${task.model} | Priority: ${task.priority}`,
      `Source: ${source}`,
      ``,
      `Approve: tasksmith approve ${task.id}`,
      `Reject:  tasksmith reject ${task.id}`,
      `Auto-rejects in ${timeoutMin} minutes.`,
    ].join("\n");

    const notification = { title, body, priority: "high" as any, taskId: task.id };
    for (const p of this.outbound) {
      try { await p.send(notification); } catch { /* best effort */ }
    }

    console.log(chalk.yellow(`[approval] ${task.id} parked — matched rule: ${matchedRule}. Awaiting approval (${timeoutMin}min timeout)`));
  }

  /**
   * Handle an approval or rejection decision.
   * Called by CLI (approve/reject commands), REST API, or timeout.
   */
  handleApprovalDecision(taskId: string, approved: boolean, decidedBy: string): boolean {
    const entry = this.approvalPending.get(taskId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.approvalPending.delete(taskId);

    // Remove from pending_approval directory
    const approvalFile = join(this.workspace, "tasks", "pending_approval", `${taskId}.yaml`);
    try { unlinkSync(approvalFile); } catch { /* already removed */ }

    if (approved) {
      console.log(chalk.green(`[approval] ${taskId} approved by ${decidedBy}`));
      this.submitTaskDirect(entry.task, entry.source);
    } else {
      entry.task.status = "failed";
      entry.task.error = `Rejected by ${decidedBy}`;
      entry.task.completedAt = new Date().toISOString();
      const failFile = join(this.workspace, "tasks", "failed", `${taskId}.yaml`);
      writeFileSync(failFile, yaml.dump(entry.task));
      console.log(chalk.red(`[approval] ${taskId} rejected by ${decidedBy}`));
    }

    return true;
  }

  /**
   * Poll for decision files written by the CLI (separate process).
   * CLI writes `.decision-<taskId>.json` to pending_approval/ since it
   * can't call handleApprovalDecision() directly.
   */
  private pollApprovalDecisions(): void {
    const approvalDir = join(this.workspace, "tasks", "pending_approval");
    if (!existsSync(approvalDir)) return;

    for (const f of readdirSync(approvalDir)) {
      if (!f.startsWith(".decision-") || !f.endsWith(".json")) continue;
      const fp = join(approvalDir, f);
      try {
        const decision = JSON.parse(readFileSync(fp, "utf-8"));
        unlinkSync(fp); // Remove decision file before processing to avoid double-processing
        const { taskId, approved, decidedBy } = decision;
        if (taskId) {
          this.handleApprovalDecision(taskId, Boolean(approved), decidedBy || "cli");
        }
      } catch (e: any) {
        console.warn(`[coordinator] Failed to process decision file ${f}: ${e.message}`);
        try { unlinkSync(fp); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Submit directly to pool — no approval check. Used after approval
   * and by the inbox scanner (file_drop tasks are local/trusted).
   */
  private submitTaskDirect(task: Task, source: string): void {
    const activeFile = join(this.workspace, "tasks", "active", `${task.id}.yaml`);
    writeFileSync(activeFile, yaml.dump(task));
    this.pool!.submit(task);
    console.log(`[coordinator] Submitted ${task.id} from ${source}`);
  }

  /**
   * Submit a parsed task — checks approval gates first.
   * If approval is required, parks the task and notifies.
   * Otherwise submits directly to the pool.
   */
  private submitTask(task: Task, source: string): void {
    const matchedRule = this.requiresApproval(task, source);
    if (matchedRule) {
      this.parkForApproval(task, source, matchedRule);
      return;
    }
    this.submitTaskDirect(task, source);
  }

  private async handleInbound(msg: InboundMessage): Promise<void> {
    // Allow plugins to inspect/transform inbound messages
    const hookResult = await this.pluginManager.executeHooks("onInboundMessage", { msg });
    if (hookResult.msg) msg = hookResult.msg as InboundMessage;

    const content = msg.content.trim();

    // Try JSON parse first (Discord/chat users may paste JSON)
    if (content.startsWith("{")) {
      try {
        const data = JSON.parse(content);
        if (data && typeof data === "object") {
          // DAG detection: has tasks array
          if (DAGManager.isDAG(data)) {
            this.cleanupSourceFile(msg);
            this.handleDAG(data, msg.source);
            return;
          }
          if ("prompt" in data || "template" in data) {
            // Sanitize before passing to engine
            const { data: clean, warnings, rejected, reason } = sanitizeTask(data, msg.source);
            if (rejected) {
              console.warn(`[coordinator] Rejected task from ${msg.source}: ${reason}`);
              return;
            }
            if (warnings.length > 0) {
              console.warn(`[coordinator] Sanitization (${msg.source}): ${warnings.join("; ")}`);
            }
            const taskYaml = yaml.dump(clean);
            const task = this.engine.parseTask(taskYaml, msg.source);
            this.cleanupSourceFile(msg);
            this.submitTask(task, msg.source);
            return;
          }
        }
      } catch { /* Not valid JSON, continue */ }
    }

    // Try YAML parse
    try {
      const data = yaml.load(content) as Record<string, any>;
      if (data && typeof data === "object") {
        // DAG detection
        if (DAGManager.isDAG(data)) {
          this.cleanupSourceFile(msg);
          this.handleDAG(data, msg.source);
          return;
        }
        if ("prompt" in data || "template" in data) {
          // Sanitize before passing to engine
          const { data: clean, warnings, rejected, reason } = sanitizeTask(data, msg.source);
          if (rejected) {
            console.warn(`[coordinator] Rejected task from ${msg.source}: ${reason}`);
            return;
          }
          if (warnings.length > 0) {
            console.warn(`[coordinator] Sanitization (${msg.source}): ${warnings.join("; ")}`);
          }
          const task = this.engine.parseTask(yaml.dump(clean), msg.source);
          this.cleanupSourceFile(msg);
          this.submitTask(task, msg.source);
          return;
        }
      }
    } catch { /* Not YAML, try NL */ }

    // Natural language → task (nlToTask handles its own sanitization via source)
    const task = this.nlToTask(content, msg);
    this.cleanupSourceFile(msg);
    this.submitTask(task, msg.source);
  }

  // ── DAG Handling ──────────────────────────────────────────────────

  /**
   * Pre-scan inbox for DAG files before pickupAll processes them.
   * DAG files have a `tasks` array and `dag_id` field. Without this,
   * they'd fail parseTask (no prompt field) and land in failed/.
   */
  private prescanInboxForDAGs(): void {
    const inboxDir = join(this.workspace, "tasks", "inbox");
    const files = readdirSync(inboxDir).filter(f => /\.(yaml|yml|json)$/.test(f) && !f.startsWith(".")).sort();
    for (const f of files) {
      const fp = join(inboxDir, f);
      try {
        const raw = readFileSync(fp, "utf-8");
        const data = f.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw) as Record<string, any>;
        if (data && typeof data === "object" && DAGManager.isDAG(data)) {
          // Move to failed dir on error, or remove after successful DAG registration
          try {
            this.handleDAG(data, "file_drop");
            unlinkSync(fp);
            console.log(`[coordinator] DAG file ${f} processed and removed from inbox`);
          } catch (e: any) {
            console.error(`[coordinator] DAG file ${f} failed: ${e.message}`);
            renameSync(fp, join(this.workspace, "tasks", "failed", f));
          }
        }
      } catch { /* Not valid YAML/JSON or read error — let pickupAll handle it */ }
    }
  }

  /**
   * Handle a DAG submission. Registers the DAG, sanitizes all tasks,
   * and submits root tasks (those with no dependencies) immediately.
   * Tasks with unmet dependencies are held in dagPending.
   */
  private handleDAG(data: Record<string, any>, source: string): void {
    const result = this.dagManager.registerDAG(data);
    if (!result) return;

    const { dagId, tasks: rawTasks } = result;

    // Parse and sanitize each task, then hold or submit
    for (const rawTask of rawTasks) {
      const { data: clean, warnings, rejected, reason } = sanitizeTask(rawTask, source);
      if (rejected) {
        console.warn(`[coordinator] DAG '${dagId}': rejected task '${rawTask.id}': ${reason}`);
        this.dagManager.reportFailure(dagId, rawTask.id);
        continue;
      }
      if (warnings.length > 0) {
        console.warn(`[coordinator] DAG '${dagId}' task '${rawTask.id}' sanitization: ${warnings.join("; ")}`);
      }

      const task = this.engine.parseTask(yaml.dump(clean), source);
      // Set DAG metadata on the parsed task
      task.dagId = dagId;
      task.dependsOn = rawTask.depends_on || [];

      const deps = task.dependsOn || [];
      if (deps.length === 0) {
        // Root task — submit immediately
        this.dagManager.markActive(dagId, task.id);
        this.submitTask(task, `dag:${dagId}`);
      } else {
        // Blocked task — hold until dependencies complete
        this.dagPending.set(task.id, task);
        console.log(`[coordinator] DAG '${dagId}': task '${task.id}' held (depends on: ${deps.join(", ")})`);
      }
    }
  }

  /**
   * Called when a task completes or fails. If the task belongs to a DAG,
   * checks for newly unblocked tasks and submits them.
   */
  private handleDAGCompletion(task: Task): void {
    if (!task.dagId) return;

    if (task.status === "completed") {
      const ready = this.dagManager.reportCompletion(task.dagId, task.id);
      for (const taskId of ready) {
        const pendingTask = this.dagPending.get(taskId);
        if (pendingTask) {
          this.dagPending.delete(taskId);
          this.dagManager.markActive(task.dagId, taskId);
          this.submitTask(pendingTask, `dag:${task.dagId}`);
        }
      }
    } else {
      const cancelled = this.dagManager.reportFailure(task.dagId, task.id);
      for (const taskId of cancelled) {
        this.dagPending.delete(taskId);
        console.log(`[coordinator] DAG '${task.dagId}': cancelled blocked task '${taskId}'`);
      }
    }
  }

  private nlToTask(text: string, msg: InboundMessage): Task {
    const tl = text.toLowerCase();

    // Detect template
    let template = "ralph-loop";
    if (/research|look into|find out|investigate/.test(tl)) template = "research";
    else if (/review|check|audit/.test(tl)) template = "code-review";
    else if (/bug|fix|broken|error|crash/.test(tl)) template = "bug-hunt";
    else if (/init|scaffold|create project|new project/.test(tl)) template = "project-init";
    else if (/docs?|document|readme/.test(tl)) template = "doc-gen";

    // Detect model
    let model = "sonnet";
    if (/opus|complex|architect|hard/.test(tl)) model = "opus";

    // Detect project (simple: look for "in <word>" or "on <word>")
    let project = "";
    const projMatch = text.match(/(?:in|on|for)\s+(\S+?)[\s.,!?]*$/i);
    if (projMatch && !/^(the|a|my|this)$/i.test(projMatch[1])) {
      project = projMatch[1];
    }

    // Detect priority
    let priority = "normal";
    if (/urgent|asap|critical|emergency/.test(tl)) priority = "urgent";
    else if (/important|high priority/.test(tl)) priority = "high";

    // Extract params from inline key=value patterns
    // e.g. "fix the auth bug validation_command=\"npm test\"" or "validate with: npm test"
    const params: Record<string, unknown> = {};

    // Match explicit key="value" patterns (quoted values)
    const kvMatches = text.matchAll(/(\w+)\s*=\s*"([^"]+)"/g);
    for (const m of kvMatches) params[m[1]] = m[2];

    // Match unquoted key=value (single word values)
    const kvSimple = text.matchAll(/(\w+)\s*=\s*(\S+)/g);
    for (const m of kvSimple) {
      if (!(m[1] in params)) params[m[1]] = m[2];
    }

    // Natural language validation detection
    // "validate with npm test" / "test with: npm run test" / "run tests: pytest"
    if (!params.validation_command) {
      const valMatch = text.match(/(?:validate|test|check)\s+(?:with|using|via|command)[:\s]+(.+?)(?:\s+(?:in|on|for)\s|$)/i);
      if (valMatch) {
        params.validation_command = valMatch[1].trim();
      }
    }

    // Sanitize the constructed task data
    const rawTask = { template, prompt: text, project, params, model, priority };
    const { data: clean, warnings } = sanitizeTask(rawTask, msg.source);
    if (warnings.length > 0) {
      console.warn(`[coordinator] NL task sanitization (${msg.source}): ${warnings.join("; ")}`);
    }

    const now = new Date().toISOString();
    const id = `task-${now.slice(0, 19).replace(/[T:]/g, "").replace(/-/g, "")}-${uuidv4().slice(0, 6)}`;

    return {
      id,
      template: clean.template || template,
      prompt: clean.prompt || text,
      project: clean.project || "",
      params: clean.params || {},
      model: clean.model || model,
      priority: clean.priority || priority,
      maxIterations: 5, notify: ["all"], status: "pending",
      createdAt: now, startedAt: "", completedAt: "",
      result: "", error: "", iterations: 0,
      sourceFile: `${msg.source}:${msg.sender}`,
    };
  }

  // ── Main Run ───────────────────────────────────────────────────

  async run(): Promise<void> {
    scaffoldWorkspace(this.workspace);
    installBundledSkills(this.workspace);

    console.log(chalk.blue("\n  Building providers..."));
    this.buildOutbound();
    this.buildInbound();
    this.buildMemory();

    // Load and activate plugins
    await this.pluginManager.loadFromConfig();
    await this.pluginManager.activateAll();

    // Merge plugin-provided providers into our lists
    this.outbound.push(...this.pluginManager.getOutboundProviders());
    this.inbound.push(...this.pluginManager.getInboundProviders());
    this.memory.push(...this.pluginManager.getMemoryProviders());

    this.buildEngine();

    // Fire onStartup hooks (postgres connects, proxmox/cloudflare verify, semantic-memory loads)
    await this.pluginManager.executeHooks("onStartup");

    // Initialize memory
    for (const p of this.memory) await p.initialize();

    // Banner
    const outNames = this.outbound.map(p => p.name).join(", ") || "none";
    const inNames = this.inbound.map(p => p.name).join(", ") || "file_drop only";
    const memNames = this.memory.map(p => p.name).join(", ");

    const engineConfig = (this.config as any).engine || {};
    const permMode = engineConfig.permissionMode || "supervised";
    const modeLabels: Record<string, string> = {
      supervised: "🟢 supervised",
      autonomous: "🟡 autonomous (acceptEdits + scoped tools)",
      yolo: "🔴 YOLO (--dangerously-skip-permissions)",
    };
    const modeLabel = modeLabels[permMode] || permMode;
        
    const W = 58; // inner width between the ║ bars
    const line = (content: string) =>
      `${chalk.blue("║")}${content.padEnd(W)}${chalk.blue("║")}`;
    const title = `TaskSmith v${pkg.version}`;

    console.log(`
    ${chalk.blue("╔" + "═".repeat(W) + "╗")}
    ${line(title.padStart((W + title.length) / 2).padEnd(W))}
    ${chalk.blue("╠" + "═".repeat(W) + "╣")}
    ${line(`  Workspace:  ${this.workspace}`)}
    ${line(`  Mode:       ${modeLabel}`)}
    ${line(`  Inbox:      ${this.engine.inbox}`)}
    ${line(`  Outbound:   ${outNames}`)}
    ${line(`  Inbound:    ${inNames}`)}
    ${line(`  Memory:     ${memNames}`)}
    ${line("")}
    ${line("  Press Ctrl+C to stop")}
    ${chalk.blue("╚" + "═".repeat(W) + "╝")}
`);

    // YOLO mode warning
    if (permMode === "yolo") {
      console.log(chalk.red.bold("  ⚠  YOLO MODE — ALL permission checks disabled."));
      console.log(chalk.red("     Claude Code will execute any operation without prompting."));
      console.log(chalk.red("     Use only in isolated environments (Docker, VM, worktree).\n"));
    }

    // Security reminder if external-facing providers are active
    const hasExternalInbound = this.inbound.some(p => ["discord_bot", "rest_api"].includes(p.name));
    if (hasExternalInbound) {
      console.log(chalk.yellow("  ⚠  External inbound providers active. Ensure access is restricted."));
      console.log(chalk.dim("     See: README.md Security section\n"));
    }

    // Initialize worker pool
    const concurrency = engineConfig.concurrency || 1;
    const poolLog = {
      info: (m: string) => console.log(`[pool] ${m}`),
      warn: (m: string) => console.log(chalk.yellow(`[pool] ${m}`)),
      error: (m: string) => console.log(chalk.red(`[pool] ${m}`)),
    };

    this.pool = new WorkerPool(
      this.workspace,
      { concurrency },
      async (task) => {
        await this.pluginManager.executeHooks("beforeTaskExecute", { task });
        await this.engine.execute(task);
        const ok = task.status === "completed";
        await this.pluginManager.executeHooks("afterTaskExecute", { task, ok });
        // Check for DAG unblocking after every task completion
        this.handleDAGCompletion(task);
      },
      poolLog,
    );

    // Pool-aware inbox scanner (with DAG detection and sanitization)
    this.scanInterval = setInterval(() => {
      if (this.shutdownRequested) return;
      try {
        // Poll for CLI approval decisions (separate process writes decision files)
        this.pollApprovalDecisions();

        // Pre-scan: detect DAG files and route them before pickupAll parses them as tasks
        this.prescanInboxForDAGs();

        const tasks = this.engine.pickupAll();
        for (const task of tasks) {
          // Sanitize tasks from inbox scanner (pickupAll doesn't sanitize)
          const source = task.sourceFile || "file_drop";
          const trust = trustLevel(source);
          if (trust === "external") {
            const { data: clean, warnings, rejected, reason } = sanitizeTask(task as any, source);
            if (rejected) {
              console.warn(`[coordinator] Rejected inbox task ${task.id}: ${reason}`);
              continue;
            }
            if (warnings.length > 0) {
              console.warn(`[coordinator] Inbox task ${task.id} sanitization: ${warnings.join("; ")}`);
            }
            // Apply sanitized fields back to the task
            Object.assign(task, clean);
          }
          this.submitTask(task, source);
        }
      } catch (e) { console.error("[coordinator] scan error:", e); }
    }, 3000);

    // Periodic progress dashboard (every 5 minutes)
    const dashboardMs = ((engineConfig.dashboardIntervalMinutes as number) || 5) * 60_000;
    this.dashboardInterval = setInterval(() => {
      if (this.shutdownRequested) return;
      const s = this.engine.stats();
      const poolStatus = this.pool!.status();
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const parts = [
        `Active: ${poolStatus.active}/${poolStatus.concurrency}`,
        `Queued: ${poolStatus.queued}`,
        `Completed: ${s.completed}`,
        `Failed: ${s.failed}`,
        `Inbox: ${s.inbox}`,
      ];
      console.log(chalk.cyan(`[status] ${time} | ${parts.join(" | ")}`));
      if (poolStatus.tasks.length > 0) {
        console.log(chalk.dim(`[status]   ${poolStatus.tasks.join("  ")}`));
      }
    }, dashboardMs);

    // Start scheduler if schedules are configured
    const schedules = ((this.config as any).scheduling?.tasks || (this.config as any).schedules) as Array<Record<string, unknown>> | undefined;
    if (schedules && schedules.length > 0) {
      const inboxDir = join(this.workspace, "tasks", "inbox");
      this.scheduler = new Scheduler(
        schedules as any,
        inboxDir,
        { info: (m) => console.log(`[scheduler] ${m}`), warn: (m) => console.log(chalk.yellow(`[scheduler] ${m}`)), error: (m) => console.log(chalk.red(`[scheduler] ${m}`)) },
      );
      this.scheduler.start();
    }

    // Start inbound listeners
    const handler = this.handleInbound.bind(this);
    for (const provider of this.inbound) {
      provider.start(handler).catch(e => console.error(`[${provider.name}] start error:`, e));
    }

    // Start API server if enabled — pass approval decision callback so API
    // routes decisions through the coordinator (clearing timers + in-memory state)
    const apiEntry = this.config.communication.inbound.find(e => e.provider === "rest_api" && e.enabled);
    if (apiEntry) {
      const approvalCb = (taskId: string, approved: boolean, decidedBy: string) =>
        this.handleApprovalDecision(taskId, approved, decidedBy);
      await createAPIServer(this.workspace, this.engine, this.memory, apiEntry.config as any, 8420, approvalCb);
    }

    // Wait for shutdown signal
    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        if (this.shutdownRequested) return;
        this.shutdownRequested = true;
        console.log(chalk.yellow("\n  Shutting down..."));
        console.log(chalk.yellow("\n  10 seconds before force exit..."));

        const forceExit = setTimeout(() => process.exit(0), 10000);

        try {
          if (this.scanInterval) clearInterval(this.scanInterval);
          if (this.dashboardInterval) clearInterval(this.dashboardInterval);
          if (this.scheduler) this.scheduler.stop();
          if (this.pool) {
            this.pool.pause();
            await this.pool.drain();
          }
          await this.pluginManager.executeHooks("onShutdown");
          await this.pluginManager.deactivateAll();
          for (const p of this.inbound) {
            try { await p.stop(); } catch { /* */ }
          }
          clearTimeout(forceExit);          
        } catch (e) { console.error("[coordinator] shutdown error:", e); }
        resolve();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  }
}
