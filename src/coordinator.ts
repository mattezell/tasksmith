/**
 * Coordinator — wires providers, engine, API, and listeners together.
 *
 * Single entry point for `tasksmith run`. Starts all enabled subsystems
 * concurrently and manages graceful shutdown.
 */

import { join, dirname } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import yaml from "js-yaml";
import chalk from "chalk";
import { v4 as uuidv4 } from "uuid";
import { scaffoldWorkspace } from "./config.js";
import { TaskEngine } from "./engine.js";
import { createAPIServer } from "./api.js";
import { OUTBOUND_REGISTRY, createInboundProvider } from "./providers/comms/providers.js";
import { MarkdownMemoryProvider, JSONLMemoryProvider, SessionArchiver, MEMORY_REGISTRY } from "./providers/memory/providers.js";
import { PluginManager } from "./plugins.js";
import { Scheduler } from "./scheduler.js";
import { WorkerPool, POOL_DEFAULTS } from "./pool.js";
import type {
  TaskSmithConfig, OutboundCommsProvider, InboundCommsProvider,
  MemoryProvider, InboundMessage, Task,
} from "./types.js";
import { readFileSync } from "node:fs";
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
  private shutdownRequested = false;
  private pluginManager: PluginManager;
  private scheduler: Scheduler | null = null;
  private pool: WorkerPool | null = null;

  constructor(workspace: string, config: TaskSmithConfig) {
    this.workspace = workspace;
    this.config = config;
    this.pluginManager = new PluginManager(workspace, config as any);
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
    this.engine.pluginManager = this.pluginManager; // enables command wrappers (sandbox plugin)
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

  /**
   * Submit a parsed task directly to the pool, bypassing the inbox.
   * Writes to active/ (not inbox/) so the file watcher and scanInbox
   * don't re-process it, avoiding the watcher -> handleInbound -> write
   * -> watcher infinite loop.
   */
  private submitTask(task: Task, source: string): void {
    const activeFile = join(this.workspace, "tasks", "active", `${task.id}.yaml`);
    writeFileSync(activeFile, yaml.dump(task));
    this.pool!.submit(task);
    console.log(`[coordinator] Submitted ${task.id} from ${source}`);
  }

  private async handleInbound(msg: InboundMessage): Promise<void> {
    const content = msg.content.trim();

    // Try JSON parse first (Discord/chat users may paste JSON)
    if (content.startsWith("{")) {
      try {
        const data = JSON.parse(content);
        if (data && typeof data === "object" && ("prompt" in data || "template" in data)) {
          const taskYaml = yaml.dump(data);
          const task = this.engine.parseTask(taskYaml, msg.source);
          this.cleanupSourceFile(msg);
          this.submitTask(task, msg.source);
          return;
        }
      } catch { /* Not valid JSON, continue */ }
    }

    // Try YAML parse
    try {
      const data = yaml.load(content) as Record<string, any>;
      if (data && typeof data === "object" && ("prompt" in data || "template" in data)) {
        const task = this.engine.parseTask(content, msg.source);
        this.cleanupSourceFile(msg);
        this.submitTask(task, msg.source);
        return;
      }
    } catch { /* Not YAML, try NL */ }

    // Natural language → task
    const task = this.nlToTask(content, msg);
    this.cleanupSourceFile(msg);
    this.submitTask(task, msg.source);
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

    const now = new Date().toISOString();
    const id = `task-${now.slice(0, 19).replace(/[T:]/g, "").replace(/-/g, "")}-${uuidv4().slice(0, 6)}`;

    return {
      id, template, prompt: text, project, params, model, priority,
      maxIterations: 5, notify: ["all"], status: "pending",
      createdAt: now, startedAt: "", completedAt: "",
      result: "", error: "", iterations: 0,
      sourceFile: `${msg.source}:${msg.sender}`,
    };
  }

  // ── Main Run ───────────────────────────────────────────────────

  async run(): Promise<void> {
    scaffoldWorkspace(this.workspace);

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
      { concurrency, worktree: { ...POOL_DEFAULTS.worktree, ...(engineConfig.worktree || {}) } },
      async (task, cwdOverride) => { await this.engine.execute(task, cwdOverride); },
      poolLog,
    );

    // Pool-aware inbox scanner
    this.scanInterval = setInterval(() => {
      if (this.shutdownRequested) return;
      try {
        const tasks = this.engine.pickupAll();
        for (const task of tasks) {
          this.pool!.submit(task);
        }
      } catch (e) { console.error("[coordinator] scan error:", e); }
    }, 3000);

    // Start scheduler if schedules are configured
    const schedules = (this.config as any).schedules as Array<Record<string, unknown>> | undefined;
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

    // Start API server if enabled
    const apiEntry = this.config.communication.inbound.find(e => e.provider === "rest_api" && e.enabled);
    if (apiEntry) {
      const host = (apiEntry.config.host as string) || "0.0.0.0";
      const port = (apiEntry.config.port as number) || 8420;
      await createAPIServer(this.workspace, this.engine, this.memory, host, port);
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
