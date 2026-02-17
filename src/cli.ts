#!/usr/bin/env node

/**
 * TaskSmith CLI
 *
 * tasksmith run         Start the engine
 * tasksmith submit      Submit a task
 * tasksmith status      System status
 * tasksmith setup       Onboarding wizard
 * tasksmith doctor      Diagnose issues
 * tasksmith memory      Browse/search memory
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { v4 as uuidv4 } from "uuid";
import yaml from "js-yaml";

import { resolveWorkspace, loadConfig, workspaceInfo, initProjectLocal, listTemplates, resolveProjectsDir, isTaskFile } from "./config.js";
import type { MemoryProvider } from "./types.js";

const program = new Command();

program
  .name("tasksmith")
  .description("Lightweight Agent Orchestration Built on Claude Code CLI")
  .version("0.3.1")
  .option("--dir <path>", "Workspace directory");

// ── RUN ────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Start the TaskSmith engine")
  .action(async () => {
    const { Coordinator } = await import("./coordinator.js");
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);
    const coordinator = new Coordinator(ws, config);
    await coordinator.run();
  });

// ── SUBMIT ─────────────────────────────────────────────────────────

program
  .command("submit")
  .description("Submit a task to the engine")
  .option("-f, --file <path>", "Submit from YAML file")
  .option("-t, --template <name>", "Template name", "ralph-loop")
  .option("-p, --prompt <text>", "Task prompt")
  .option("--project <name>", "Project name", "")
  .option("--model <model>", "Model (opus/sonnet)", "sonnet")
  .option("--priority <level>", "Priority (low/normal/high/urgent)", "normal")
  .option("--iterations <n>", "Max iterations", "5")
  .action(async (opts) => {
    const ws = resolveWorkspace(program.opts().dir);
    const inbox = join(ws, "tasks", "inbox");
    mkdirSync(inbox, { recursive: true });

    if (opts.file) {
      const src = opts.file;
      if (!existsSync(src)) {
        console.error(chalk.red(`File not found: ${src}`));
        process.exit(1);
      }
      const dest = join(inbox, src.split("/").pop()!);
      writeFileSync(dest, readFileSync(src, "utf-8"));
      console.log(chalk.green("Submitted:"), dest);
      return;
    }

    let prompt = opts.prompt;
    if (!prompt) {
      const inquirer = await import("inquirer");
      const answers = await inquirer.default.prompt([
        { name: "prompt", message: "Prompt:", type: "input" },
        { name: "template", message: "Template:", default: opts.template },
        { name: "model", message: "Model:", default: opts.model },
      ]);
      prompt = answers.prompt;
      opts.template = answers.template;
      opts.model = answers.model;
    }

    if (!prompt) {
      console.error(chalk.red("Prompt is required."));
      process.exit(1);
    }

    const now = new Date().toISOString();
    const taskId = `task-${now.slice(0, 19).replace(/[T:]/g, "").replace(/-/g, "")}-${uuidv4().slice(0, 6)}`;
    const taskData = {
      id: taskId,
      template: opts.template,
      prompt,
      project: opts.project,
      model: opts.model,
      priority: opts.priority,
      max_iterations: parseInt(opts.iterations),
      created_at: now,
    };

    const dest = join(inbox, `${taskId}.yaml`);
    writeFileSync(dest, yaml.dump(taskData));

    console.log(chalk.green("\n  Task Submitted"));
    console.log(`  ID:       ${chalk.bold(taskId)}`);
    console.log(`  Template: ${opts.template}`);
    console.log(`  Model:    ${opts.model}`);
    console.log(`  Priority: ${opts.priority}`);
    console.log(`  Prompt:   ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}\n`);
  });

// ── STATUS ─────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show system status")
  .action(async () => {
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);
    const info = workspaceInfo(ws);

    console.log(chalk.bold("\n  Workspace"));
    console.log(`    Mode         ${chalk.cyan(info.mode)}`);
    console.log(`    Path         ${info.path}`);
    console.log(`    Projects     ${info.projectsDir}`);

    console.log(chalk.bold("\n  Task Queue"));
    for (const [label, dir] of [["Pending", "inbox"], ["Active", "active"], ["Completed", "completed"], ["Failed", "failed"]] as const) {
      const d = join(ws, "tasks", dir);
      const count = existsSync(d) ? readdirSync(d).filter(f => isTaskFile(f)).length : 0;
      const color = dir === "active" ? chalk.yellow : dir === "failed" ? chalk.red : dir === "completed" ? chalk.green : chalk.white;
      console.log(`    ${label.padEnd(12)} ${color(String(count))}`);
    }

    console.log(chalk.bold("\n  Infrastructure"));
    let ccVersion = "";
    try { ccVersion = execSync("claude --version", { encoding: "utf-8", timeout: 5000 }).trim().split("\n")[0]; } catch { /* */ }
    console.log(`    Claude Code  ${ccVersion ? chalk.green(ccVersion) : chalk.red("not found")}`);

    let ollamaOk = false;
    try { const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) }); ollamaOk = r.ok; } catch { /* */ }
    console.log(`    Ollama       ${ollamaOk ? chalk.green("running") : chalk.dim("not running")}`);

    const outCount = config.communication.outbound.filter(e => e.enabled).length;
    const inCount = config.communication.inbound.filter(e => e.enabled).length;
    console.log(`    Outbound     ${outCount} provider(s)`);
    console.log(`    Inbound      ${inCount} provider(s)`);

    console.log(chalk.bold("\n  Directives"));
    for (const f of ["SOUL.md", "USER.md", "MEMORY.md", "CONVENTIONS.md", "GLOSSARY.md"]) {
      const exists = existsSync(join(ws, "directives", f));
      console.log(`    ${exists ? chalk.green("✓") : chalk.dim("—")} ${f}`);
    }
    console.log();
  });

// ── DOCTOR ─────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Diagnose common issues")
  .action(async () => {
    const ws = resolveWorkspace(program.opts().dir);
    const issues: [string, string][] = [];

    // Claude Code
    try { execSync("claude --version", { timeout: 5000 }); } catch {
      issues.push(["Claude Code CLI not found", "npm install -g @anthropic-ai/claude-code"]);
    }

    // Workspace
    if (!existsSync(ws)) issues.push(["Workspace doesn't exist", "tasksmith setup"]);

    for (const d of ["tasks/inbox", "directives", "memory", "config"]) {
      if (!existsSync(join(ws, d))) issues.push([`Missing directory: ${d}`, "tasksmith setup"]);
    }

    if (!existsSync(join(ws, "directives", "SOUL.md"))) {
      issues.push(["SOUL.md not found", "tasksmith setup"]);
    }

    if (issues.length) {
      console.log(chalk.red("\n  Issues Found\n"));
      for (const [issue, fix] of issues) {
        console.log(`    ${chalk.red("✗")} ${issue}`);
        console.log(`      ${chalk.dim(fix)}`);
      }
    } else {
      console.log(chalk.green("\n  No issues found. System looks healthy.\n"));
    }
  });

// ── MEMORY ─────────────────────────────────────────────────────────

program
  .command("memory")
  .description("Browse and search memory")
  .option("-s, --search <query>", "Search memory")
  .option("-r, --recent <n>", "Show N recent entries")
  .option("--hot", "Show hot memory context")
  .action(async (opts) => {
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);
    const { MarkdownMemoryProvider, JSONLMemoryProvider } = await import("./providers/memory/providers.js");

    const md = new MarkdownMemoryProvider(config.memory.hot.config, ws);
    await md.initialize();

    if (opts.hot) {
      console.log(chalk.bold("\n  Hot Memory Context\n"));
      console.log(md.getHotContext() || chalk.dim("  (empty)"));
      console.log();
      return;
    }

    const providers: MemoryProvider[] = [md as MemoryProvider];
    for (const entry of config.memory.warm) {
      if (entry.provider === "jsonl_logs") {
        const jl = new JSONLMemoryProvider(entry.config, ws);
        await jl.initialize();
        providers.push(jl);
      }
    }

    if (opts.search) {
      console.log(chalk.bold(`\n  Memory Search: '${opts.search}'\n`));
      for (const p of providers) {
        const hits = await p.search(opts.search, 5);
        for (const h of hits) {
          console.log(`    [${chalk.cyan(p.name)}] ${chalk.dim(h.score.toFixed(1))} ${h.content.slice(0, 120)}`);
        }
      }
    } else if (opts.recent) {
      console.log(chalk.bold(`\n  Recent Memory (${opts.recent})\n`));
      for (const p of providers) {
        const entries = await p.getRecent(parseInt(opts.recent));
        for (const e of entries) {
          console.log(`    [${chalk.cyan(p.name)}] ${e.content.slice(0, 120)}`);
        }
      }
    } else {
      console.log("  Use --search, --recent, or --hot");
      console.log(`  Example: ${chalk.dim("tasksmith memory --search 'auth bug'")}\n`);
    }
  });

// ── SETUP ──────────────────────────────────────────────────────────

program
  .command("setup")
  .description("Run the onboarding wizard")
  .option("--step <name>", "Run specific step")
  .action(async (opts) => {
    const { runSetup } = await import("./onboarding.js");
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);
    await runSetup(ws, config, opts.step);
  });

// ── PLUGIN ─────────────────────────────────────────────────────────

const pluginCmd = program
  .command("plugin")
  .description("Manage plugins");

pluginCmd
  .command("list")
  .description("List installed and discovered plugins")
  .action(async () => {
    const { PluginManager } = await import("./plugins.js");
    const { listBundledPlugins, BUNDLED_PLUGIN_INFO } = await import("./plugins/bundled/index.js");
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);
    const pm = new PluginManager(ws, config as any);

    // Bundled (official) plugins
    const bundled = listBundledPlugins();
    const enabledPlugins = ((config as any).plugins || []) as Array<string | Record<string, unknown>>;
    const enabledNames = new Set(enabledPlugins.map((e: any) => typeof e === "string" ? e : (e.name || "")));

    console.log(chalk.bold(`\n  Official Plugins (bundled)\n`));
    for (const name of bundled) {
      const enabled = enabledNames.has(name);
      const info = BUNDLED_PLUGIN_INFO[name];
      const icon = enabled ? chalk.green("\u25cf") : chalk.dim("\u25cb");
      const status = enabled ? chalk.green("enabled") : chalk.dim("disabled");
      console.log(`    ${icon} ${name.padEnd(12)} ${status.padEnd(18)} ${chalk.dim(info?.description || "")}`);
    }

    // npm-discovered plugins
    const discovered = await pm.discover();
    if (discovered.length > 0) {
      console.log(chalk.bold(`\n  Community Plugins (npm)\n`));
      for (const name of discovered) {
        console.log(`    ${chalk.green("\u25cf")} ${name}`);
      }
    }

    console.log(chalk.bold("\n  Enable a plugin:"));
    console.log(chalk.dim("    Add to plugins: list in ~/.tasksmith/config/tasksmith.yaml\n"));
    console.log(chalk.dim("    plugins:"));
    console.log(chalk.dim("      - github"));
    console.log(chalk.dim("      - name: metrics"));
    console.log(chalk.dim("        config:"));
    console.log(chalk.dim("          retainDays: 90\n"));
  });


pluginCmd
  .command("create <name>")
  .description("Scaffold a new plugin")
  .action(async (name: string) => {
    const { scaffoldPlugin } = await import("./plugins.js");
    scaffoldPlugin(name, process.cwd());
  });

// ── INIT (project-local) ───────────────────────────────────────────

program
  .command("init")
  .description("Initialize TaskSmith in the current project (creates .tasksmith/)")
  .action(async () => {
    const cwd = process.cwd();
    const tsDir = initProjectLocal(cwd);
    console.log(chalk.green("\n  Initialized TaskSmith in current project\n"));
    console.log(`  Config:     ${join(tsDir, "config", "tasksmith.yaml")}`);
    console.log(`  Templates:  ${join(tsDir, "templates/")}`);
    console.log(`  Directives: ${join(tsDir, "directives/")}`);
    console.log(`  Task inbox: ${join(tsDir, "tasks", "inbox/")}`);
    console.log();
    console.log(`  ${chalk.dim("Global config at ~/.tasksmith is inherited.")}`);
    console.log(`  ${chalk.dim("Project-local settings override global ones.")}`);
    console.log(`  ${chalk.dim("Drop task YAML or JSON files in tasks/inbox/ to run them.")}\n`);
  });

// ── TEMPLATES ──────────────────────────────────────────────────────

program
  .command("templates")
  .description("List all available templates and where they come from")
  .action(async () => {
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);
    const templates = listTemplates(ws, config);

    if (templates.length === 0) {
      console.log(chalk.dim("\n  No templates found.\n"));
      return;
    }

    console.log(chalk.bold(`\n  Available Templates (${templates.length})\n`));
    const sourceColors: Record<string, (s: string) => string> = {
      "project-local": chalk.magenta,
      "workspace": chalk.cyan,
      "custom": chalk.yellow,
      "global": chalk.blue,
      "built-in": chalk.dim,
    };
    for (const t of templates) {
      const colorFn = sourceColors[t.source] || chalk.white;
      console.log(`    ${chalk.green("●")} ${t.name.padEnd(24)} ${colorFn(t.source.padEnd(16))} ${chalk.dim(t.path)}`);
    }
    console.log();
    console.log(chalk.dim("  Priority: project-local > workspace > custom > global > built-in"));
    console.log(chalk.dim("  Override a built-in by placing your version in .tasksmith/templates/ or ~/.tasksmith/templates/\n"));
  });

// ── INFO ───────────────────────────────────────────────────────────

program
  .command("info")
  .description("Show workspace resolution and config details")
  .action(async () => {
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);
    const info = workspaceInfo(ws);

    console.log(chalk.bold("\n  Workspace Resolution\n"));
    console.log(`    Mode:          ${chalk.cyan(info.mode)}`);
    console.log(`    Workspace:     ${info.path}`);
    console.log(`    Projects dir:  ${info.projectsDir}`);
    console.log(`    Global config: ${join(homedir(), ".tasksmith")}`);

    if (config.workspace?.templatesDir) {
      console.log(`    Extra templates: ${config.workspace.templatesDir}`);
    }

    console.log(chalk.bold("\n  Resolution Order"));
    console.log(`    1. ${chalk.dim("--dir flag")}          ${program.opts().dir || chalk.dim("(not set)")}`);
    console.log(`    2. ${chalk.dim("TASKSMITH_DIR env")}   ${process.env.TASKSMITH_DIR || chalk.dim("(not set)")}`);
    console.log(`    3. ${chalk.dim("Project-local")}      ${existsSync(join(process.cwd(), ".tasksmith")) ? chalk.green("found .tasksmith/") : chalk.dim("(not found)")}`);
    console.log(`    4. ${chalk.dim("Global fallback")}    ~/.tasksmith`);

    console.log(chalk.bold("\n  Template Search Paths"));
    const searchPaths = [
      [".tasksmith/templates/", "project-local"],
      [join(ws, "templates/"), "workspace"],
      ...(config.workspace?.templatesDir ? [[config.workspace.templatesDir, "custom"]] : []),
      [join(homedir(), ".tasksmith", "templates/"), "global"],
      ["<install>/templates/", "built-in"],
    ];
    for (const [path, label] of searchPaths) {
      console.log(`    ${chalk.dim(`[${label}]`.padEnd(18))} ${path}`);
    }
    console.log();
  });

// ── PARSE & RUN ────────────────────────────────────────────────────

program.parse();
