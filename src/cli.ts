#!/usr/bin/env node

/**
 * TaskSmith CLI
 *
 * tasksmith run                Start the engine
 * tasksmith mcp                Start MCP server (stdio transport)
 * tasksmith submit             Submit a task
 * tasksmith status             System status
 * tasksmith setup              Onboarding wizard
 * tasksmith doctor             Diagnose issues
 * tasksmith memory             Browse/search memory
 * tasksmith workers            Show pool config & worktree status
 * tasksmith workers --cleanup  Remove stale worktrees
 * tasksmith workers --dry-run  Preview what --cleanup would remove
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";
import yaml from "js-yaml";

import { resolveWorkspace, loadConfig, workspaceInfo, initProjectLocal, listTemplates, resolveProjectsDir, isTaskFile } from "./config.js";
import type { MemoryProvider } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();

program
  .name("tasksmith")
  .description("Lightweight Agent Orchestration Built on Claude Code CLI")
  .version(pkg.version)
  .option("--dir <path>", "Workspace directory");

// ── RUN ────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Start the TaskSmith engine")
  .option("--mode <mode>", "Permission mode: supervised, autonomous, or yolo")
  .action(async (opts) => {
    const { Coordinator } = await import("./coordinator.js");
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);

    // CLI --mode overrides config
    if (opts.mode) {
      const valid = ["supervised", "autonomous", "yolo"];
      if (!valid.includes(opts.mode)) {
        console.error(chalk.red(`Invalid mode: ${opts.mode}. Must be one of: ${valid.join(", ")}`));
        process.exit(1);
      }
      if (!config.engine) (config as any).engine = {};
      (config as any).engine.permissionMode = opts.mode;
    }

    const coordinator = new Coordinator(ws, config);
    await coordinator.run();
  });

// ── MCP ───────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Start TaskSmith as an MCP server (stdio transport)")
  .action(async () => {
    const { startMCPServer } = await import("./mcp.js");
    await startMCPServer(program.opts().dir);
  });

// ── DAG ───────────────────────────────────────────────────────────

program
  .command("dag")
  .description("Show DAG (dependency workflow) status")
  .option("-l, --list", "List all DAGs")
  .option("-s, --status <dagId>", "Show status of a specific DAG")
  .option("-f, --file <path>", "Submit a DAG file")
  .action(async (opts: any) => {
    const ws = resolveWorkspace(program.opts().dir);
    const { DAGManager } = await import("./dag.js");
    const dagMgr = new DAGManager(ws);

    if (opts.file) {
      // Submit a DAG file
      const content = readFileSync(opts.file, "utf-8");
      const data = yaml.load(content) as Record<string, any>;
      if (!DAGManager.isDAG(data)) {
        console.error(chalk.red("File is not a DAG (no 'tasks' array found)"));
        return;
      }
      const result = dagMgr.registerDAG(data);
      if (result) {
        console.log(chalk.green(`DAG '${result.dagId}' registered with ${result.tasks.length} tasks`));
        console.log(chalk.dim("Submit to the running engine by dropping the file in tasks/inbox/"));
        const inbox = join(ws, "tasks", "inbox");
        mkdirSync(inbox, { recursive: true });
        const dest = join(inbox, `${result.dagId}.yaml`);
        writeFileSync(dest, yaml.dump(data));
        console.log(chalk.green(`  → Copied to ${dest}`));
      }
      return;
    }

    if (opts.status) {
      const status = dagMgr.getStatus(opts.status);
      if (status) {
        console.log(status);
      } else {
        console.log(chalk.dim(`DAG '${opts.status}' not found.`));
      }
      return;
    }

    // Default: list all DAGs
    const dags = dagMgr.listDAGs();
    if (dags.length === 0) {
      console.log(chalk.dim("No DAGs found."));
      return;
    }

    for (const dag of dags) {
      const completed = dag.nodes.filter(n => n.status === "completed").length;
      const total = dag.nodes.length;
      const icon = dag.status === "completed" ? chalk.green("✓") :
        dag.status === "failed" ? chalk.red("✗") : chalk.yellow("◉");
      console.log(`  ${icon} ${dag.dagId} — ${completed}/${total} tasks — ${dag.status}`);
    }
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
  .option("--param <key=value>", "Task params (repeatable): --param validation_command=\"npm test\"", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
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

      // Ask for validation command when ralph-loop or bug-hunt
      if (["ralph-loop", "bug-hunt"].includes(opts.template) && !(opts.param || []).some((p: string) => p.startsWith("validation_command"))) {
        const valAnswer = await inquirer.default.prompt([
          { name: "validation_command", message: "Validation command (enter to skip):", type: "input", default: "" },
        ]);
        if (valAnswer.validation_command) {
          (opts.param as string[]).push(`validation_command=${valAnswer.validation_command}`);
        }
      }
    }

    if (!prompt) {
      console.error(chalk.red("Prompt is required."));
      process.exit(1);
    }

    const now = new Date().toISOString();
    const taskId = `task-${now.slice(0, 19).replace(/[T:]/g, "").replace(/-/g, "")}-${uuidv4().slice(0, 6)}`;

    // Parse --param key=value pairs
    const params: Record<string, unknown> = {};
    for (const raw of (opts.param || []) as string[]) {
      const eq = raw.indexOf("=");
      if (eq === -1) {
        params[raw] = true;
      } else {
        const key = raw.slice(0, eq);
        let value: unknown = raw.slice(eq + 1);
        if (value === "true") value = true;
        else if (value === "false") value = false;
        else if (/^\d+(\.\d+)?$/.test(value as string)) value = Number(value);
        params[key] = value;
      }
    }

    const taskData: Record<string, unknown> = {
      id: taskId,
      template: opts.template,
      prompt,
      project: opts.project,
      model: opts.model,
      priority: opts.priority,
      max_iterations: parseInt(opts.iterations),
      created_at: now,
    };

    if (Object.keys(params).length > 0) {
      taskData.params = params;
    }

    const dest = join(inbox, `${taskId}.yaml`);
    writeFileSync(dest, yaml.dump(taskData));

    console.log(chalk.green("\n  Task Submitted"));
    console.log(`  ID:       ${chalk.bold(taskId)}`);
    console.log(`  Template: ${opts.template}`);
    console.log(`  Model:    ${opts.model}`);
    console.log(`  Priority: ${opts.priority}`);
    if (Object.keys(params).length > 0) {
      console.log(`  Params:   ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
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

    const permMode = (config as any).engine?.permissionMode || "supervised";
    const modeColors: Record<string, (s: string) => string> = { supervised: chalk.green, autonomous: chalk.yellow, yolo: chalk.red };
    console.log(`    Permissions  ${(modeColors[permMode] || chalk.white)(permMode)}`);

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

    const permMode = (config as any).engine?.permissionMode || "supervised";
    const modeColors: Record<string, (s: string) => string> = { supervised: chalk.green, autonomous: chalk.yellow, yolo: chalk.red };
    console.log(`    Permissions:   ${(modeColors[permMode] || chalk.white)(permMode)}`);

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

// ── WORKERS ─────────────────────────────────────────────────────────

program
  .command("workers")
  .description("Show worker pool and worktree configuration")
  .option("--cleanup", "Remove stale worktrees for completed/failed/orphaned tasks")
  .option("--dry-run", "Show what --cleanup would remove without actually removing")
  .action(async (opts) => {
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);

    // ── Cleanup mode ──────────────────────────────────────────────
    if (opts.cleanup || opts.dryRun) {
      const { spawnSync: ss } = await import("node:child_process");
      const wtBaseDir = join(ws, "worktrees");
      const activeDir = join(ws, "tasks", "active");
      const dryRun = opts.dryRun && !opts.cleanup;

      if (!existsSync(wtBaseDir)) {
        console.log(chalk.dim("\n  No worktree directory found. Nothing to clean up.\n"));
        return;
      }

      // Get active task IDs (tasks currently being executed)
      const activeTasks = new Set(
        existsSync(activeDir)
          ? readdirSync(activeDir).filter(f => isTaskFile(f)).map(f => f.replace(/\.(yaml|yml|json)$/, ""))
          : []
      );

      // Scan worktree directory for task worktrees
      const entries = readdirSync(wtBaseDir).filter(e =>
        existsSync(join(wtBaseDir, e)) && e.startsWith("task-")
      );

      if (entries.length === 0) {
        console.log(chalk.green("\n  No worktrees found. Clean.\n"));
        return;
      }

      interface StaleWorktree {
        taskId: string;
        path: string;
        branch: string;
        repoPath: string;
        reason: string;
      }

      const stale: StaleWorktree[] = [];
      const active: string[] = [];

      for (const taskId of entries) {
        const wtPath = join(wtBaseDir, taskId);

        if (activeTasks.has(taskId)) {
          active.push(taskId);
          continue;
        }

        // Determine reason: completed, failed, or orphaned (no task file at all)
        let reason = "orphaned";
        if (existsSync(join(ws, "tasks", "completed", `${taskId}.yaml`))) reason = "completed";
        else if (existsSync(join(ws, "tasks", "failed", `${taskId}.yaml`))) reason = "failed";

        // Get branch name and repo path from the worktree
        const branchRes = ss("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: wtPath, encoding: "utf-8", stdio: "pipe",
        });
        const branch = branchRes.status === 0 ? (branchRes.stdout || "").trim() : "unknown";

        // Get the main repo path (worktree's parent repo)
        const repoRes = ss("git", ["config", "--get", "remote.origin.url"], {
          cwd: wtPath, encoding: "utf-8", stdio: "pipe",
        });
        // For repo path, find the actual git dir's commondir (points back to main repo)
        const commonRes = ss("git", ["rev-parse", "--git-common-dir"], {
          cwd: wtPath, encoding: "utf-8", stdio: "pipe",
        });
        let repoPath = "";
        if (commonRes.status === 0) {
          // --git-common-dir returns something like /path/to/repo/.git
          const gitDir = (commonRes.stdout || "").trim();
          repoPath = gitDir.endsWith("/.git") ? gitDir.slice(0, -5) : gitDir;
        }

        stale.push({ taskId, path: wtPath, branch, repoPath, reason });
      }

      // Report
      console.log(chalk.bold(`\n  Worktree Cleanup${dryRun ? chalk.yellow(" (dry run)") : ""}\n`));

      if (active.length > 0) {
        console.log(`    ${chalk.green("Active")} (skipping): ${active.length}`);
        for (const id of active) {
          console.log(`      ${chalk.dim("→")} ${id}`);
        }
      }

      if (stale.length === 0) {
        console.log(chalk.green("    No stale worktrees found.\n"));
        return;
      }

      console.log(`    ${chalk.yellow("Stale")} (to remove): ${stale.length}\n`);
      for (const s of stale) {
        const reasonColor = s.reason === "completed" ? chalk.green : s.reason === "failed" ? chalk.red : chalk.yellow;
        console.log(`      ${reasonColor(s.reason.padEnd(10))} ${s.taskId}`);
        console.log(`      ${chalk.dim(`branch: ${s.branch}`)}`);
        if (s.repoPath) console.log(`      ${chalk.dim(`repo:   ${s.repoPath}`)}`);
      }

      if (dryRun) {
        console.log(chalk.dim(`\n    Run ${chalk.bold("tasksmith workers --cleanup")} to remove these.\n`));
        return;
      }

      // Perform cleanup
      console.log();
      let removed = 0;
      let failed = 0;

      for (const s of stale) {
        try {
          // Remove worktree via git (from the parent repo)
          if (s.repoPath && existsSync(s.repoPath)) {
            ss("git", ["worktree", "remove", s.path, "--force"], {
              cwd: s.repoPath, encoding: "utf-8", stdio: "pipe",
            });
            // Delete the branch
            if (s.branch && s.branch !== "unknown") {
              ss("git", ["branch", "-D", s.branch], {
                cwd: s.repoPath, encoding: "utf-8", stdio: "pipe",
              });
            }
          }

          // Fallback: if worktree dir still exists, remove it directly
          if (existsSync(s.path)) {
            const { rmSync: rm } = await import("node:fs");
            rm(s.path, { recursive: true, force: true });
          }

          console.log(`    ${chalk.green("✓")} Removed ${s.taskId} (${s.branch})`);
          removed++;
        } catch (e: any) {
          console.log(`    ${chalk.red("✗")} Failed to remove ${s.taskId}: ${e.message}`);
          failed++;
        }
      }

      console.log(`\n    ${chalk.green(`${removed} removed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ""}\n`);
      return;
    }

    // ── Info mode (default) ───────────────────────────────────────
    const engine = (config as any).engine || {};
    const wt = engine.worktree || {};

    console.log(chalk.bold("\n  Worker Pool Configuration\n"));
    console.log(`    Concurrency:   ${chalk.bold(engine.concurrency || 1)}`);
    console.log(`    Worktree:      ${wt.enabled ? chalk.green("enabled") : chalk.dim("disabled")}`);

    if (wt.enabled) {
      console.log(`    Strategy:      ${chalk.cyan(wt.strategy || "pr")}`);
      console.log(`    Base branch:   ${wt.baseBranch || "main"}`);
      console.log(`    PR labels:     ${(wt.prLabels || ["tasksmith"]).join(", ")}`);
      console.log(`    Cleanup:       success=${wt.cleanupOnSuccess ?? true}, failure=${wt.cleanupOnFailure ?? true}`);

      // Check git and gh
      const { spawnSync } = await import("node:child_process");
      const gitOk = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: ws, encoding: "utf-8", stdio: "pipe" }).status === 0;
      const ghOk = spawnSync("gh", ["--version"], { encoding: "utf-8", stdio: "pipe" }).status === 0;

      console.log(`\n    Git repo:      ${gitOk ? chalk.green("yes") : chalk.red("no")}`);
      console.log(`    gh CLI:        ${ghOk ? chalk.green("available") : chalk.yellow("not found (needed for PR strategy)")}`);

      // List worktrees from the worktree base directory
      const wtBaseDir = join(ws, "worktrees");
      if (existsSync(wtBaseDir)) {
        const wtEntries = readdirSync(wtBaseDir).filter(e => e.startsWith("task-"));
        if (wtEntries.length > 0) {
          console.log(chalk.bold(`\n    Worktrees on Disk (${wtEntries.length}):`));
          const activeDir = join(ws, "tasks", "active");
          const activeTasks = new Set(
            existsSync(activeDir)
              ? readdirSync(activeDir).filter(f => isTaskFile(f)).map(f => f.replace(/\.(yaml|yml|json)$/, ""))
              : []
          );
          for (const taskId of wtEntries) {
            const isActive = activeTasks.has(taskId);
            const icon = isActive ? chalk.green("●") : chalk.yellow("○");
            const label = isActive ? "active" : "stale";
            console.log(`      ${icon} ${taskId} ${chalk.dim(`(${label})`)}`);
          }
          const staleCount = wtEntries.filter(id => !activeTasks.has(id)).length;
          if (staleCount > 0) {
            console.log(chalk.dim(`\n    ${staleCount} stale — run ${chalk.bold("tasksmith workers --cleanup")} to remove`));
          }
        }
      }
    } else {
      console.log(chalk.dim("\n    Enable with:"));
      console.log(chalk.dim("    engine:"));
      console.log(chalk.dim("      concurrency: 3"));
      console.log(chalk.dim("      worktree:"));
      console.log(chalk.dim('        enabled: true'));
      console.log(chalk.dim('        strategy: "pr"'));
    }

    console.log();
  });

// ── SCHEDULE ────────────────────────────────────────────────────────

program
  .command("schedule")
  .description("Show configured task schedules")
  .action(async () => {
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);
    const schedules = (config as any).schedules as Array<Record<string, unknown>> | undefined;

    console.log(chalk.bold("\n  Task Schedules\n"));

    if (!schedules || schedules.length === 0) {
      console.log(chalk.dim("    No schedules configured."));
      console.log(chalk.dim("\n    Add to tasksmith.yaml:"));
      console.log(chalk.dim('    schedules:'));
      console.log(chalk.dim('      - name: "nightly-consolidation"'));
      console.log(chalk.dim('        template: heartbeat'));
      console.log(chalk.dim('        prompt: "Consolidate memory"'));
      console.log(chalk.dim('        cron: "0 2 * * *"'));
      console.log(chalk.dim('        enabled: true'));
      console.log();
      return;
    }

    const { describeCron } = await import("./scheduler.js");

    for (const s of schedules) {
      const enabled = s.enabled !== false;
      const icon = enabled ? chalk.green("✓") : chalk.dim("○");
      const name = (s.name as string || "unnamed").padEnd(24);
      const desc = describeCron(s.cron as string || "");
      const template = s.template as string || "?";

      console.log(`    ${icon} ${chalk.bold(name)} ${chalk.cyan(template.padEnd(14))} ${desc}`);
      if (s.project) console.log(`      ${chalk.dim(`project: ${s.project}`)}`);
    }
    console.log();
  });

// ── PARSE & RUN ────────────────────────────────────────────────────

program.parse();
