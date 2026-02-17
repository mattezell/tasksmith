/**
 * Coordinator — wires providers, engine, API, and listeners together.
 *
 * Single entry point for `tasksmith run`. Starts all enabled subsystems
 * concurrently and manages graceful shutdown.
 */

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import yaml from "js-yaml";
import chalk from "chalk";
import { v4 as uuidv4 } from "uuid";
import { scaffoldWorkspace } from "./config.js";
import { TaskEngine } from "./engine.js";
import { createAPIServer } from "./api.js";
import { OUTBOUND_REGISTRY, createInboundProvider } from "./providers/comms/providers.js";
import { MarkdownMemoryProvider, JSONLMemoryProvider, SessionArchiver, MEMORY_REGISTRY } from "./providers/memory/providers.js";
import { PluginManager } from "./plugins.js";
import type {
  ForgeConfig, OutboundCommsProvider, InboundCommsProvider,
  MemoryProvider, InboundMessage, Task,
} from "./types.js";

export class Coordinator {
  private workspace: string;
  private config: ForgeConfig;

  private engine!: TaskEngine;
  private outbound: OutboundCommsProvider[] = [];
  private inbound: InboundCommsProvider[] = [];
  private memory: MemoryProvider[] = [];
  private hotMemory: MarkdownMemoryProvider | null = null;
  private archiver: SessionArchiver | null = null;

  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private shutdownRequested = false;
  private pluginManager: PluginManager;

  constructor(workspace: string, config: ForgeConfig) {
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
  }

  // ── Inbound Handler ────────────────────────────────────────────

  private async handleInbound(msg: InboundMessage): Promise<void> {
    const content = msg.content.trim();

    // Try YAML parse first
    try {
      const data = yaml.load(content) as Record<string, any>;
      if (data && typeof data === "object" && ("prompt" in data || "template" in data)) {
        const task = this.engine.parseTask(content, msg.source);
        const taskFile = join(this.workspace, "tasks", "inbox", `${task.id}.yaml`);
        writeFileSync(taskFile, yaml.dump(task));
        console.log(`[coordinator] Queued task ${task.id} from ${msg.source}`);
        return;
      }
    } catch { /* Not YAML, try NL */ }

    // Natural language → task
    const task = this.nlToTask(content, msg);
    const taskFile = join(this.workspace, "tasks", "inbox", `${task.id}.yaml`);
    writeFileSync(taskFile, yaml.dump(task));
    console.log(`[coordinator] Queued NL task ${task.id} from ${msg.source}:${msg.sender}`);
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

    const now = new Date().toISOString();
    const id = `task-${now.slice(0, 19).replace(/[T:]/g, "").replace(/-/g, "")}-${uuidv4().slice(0, 6)}`;

    return {
      id, template, prompt: text, project, params: {}, model, priority,
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

    console.log(`
${chalk.blue("╔══════════════════════════════════════════════════════╗")}
${chalk.blue("║")}           ${chalk.bold("TaskSmith v0.3.0")}                     ${chalk.blue("║")}
${chalk.blue("╠══════════════════════════════════════════════════════╣")}
${chalk.blue("║")}  Workspace:  ${this.workspace.padEnd(38)} ${chalk.blue("║")}
${chalk.blue("║")}  Inbox:      ${this.engine.inbox.padEnd(38)} ${chalk.blue("║")}
${chalk.blue("║")}  Outbound:   ${outNames.padEnd(38)} ${chalk.blue("║")}
${chalk.blue("║")}  Inbound:    ${inNames.padEnd(38)} ${chalk.blue("║")}
${chalk.blue("║")}  Memory:     ${memNames.padEnd(38)} ${chalk.blue("║")}
${chalk.blue("║")}                                                      ${chalk.blue("║")}
${chalk.blue("║")}  Press Ctrl+C to stop                                ${chalk.blue("║")}
${chalk.blue("╚══════════════════════════════════════════════════════╝")}
`);

    // Start inbox scanner (polling — belt + suspenders with chokidar in FileDropProvider)
    this.scanInterval = setInterval(async () => {
      if (!this.shutdownRequested) {
        try { await this.engine.scanInbox(); } catch (e) { console.error("[coordinator] scan error:", e); }
      }
    }, 3000);

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

        if (this.scanInterval) clearInterval(this.scanInterval);
        await this.pluginManager.executeHooks("onShutdown");
        await this.pluginManager.deactivateAll();
        for (const p of this.inbound) {
          try { await p.stop(); } catch { /* */ }
        }
        resolve();
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  }
}
