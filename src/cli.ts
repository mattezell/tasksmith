#!/usr/bin/env node

/**
 * TaskSmith CLI — The unattended ops layer for Claude Code
 *
 * tasksmith run         Start the engine
 * tasksmith mcp         Start MCP server (stdio transport)
 * tasksmith submit      Submit a task
 * tasksmith dag         Manage DAG workflows
 * tasksmith status      System status
 * tasksmith setup       Setup wizard
 * tasksmith doctor      Diagnose issues
 * tasksmith memory      Browse/search memory
 * tasksmith workers     Show pool configuration
 * tasksmith schedule    Show configured schedules
 * tasksmith info        Workspace resolution details
 * tasksmith init        Initialize project-local config
 * tasksmith plugin      Manage plugins
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";
import yaml from "js-yaml";

import { resolveWorkspace, loadConfig, workspaceInfo, initProjectLocal, isTaskFile } from "./config.js";
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
  .option("-g, --graph <dagId>", "Output DAG as Mermaid flowchart")
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

    if (opts.graph) {
      const mermaid = dagMgr.toMermaid(opts.graph);
      if (mermaid) {
        console.log(mermaid);
      } else {
        console.log(chalk.dim(`DAG '${opts.graph}' not found.`));
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
  .option("--from-github-issue <number>", "Create task from a GitHub issue (requires gh CLI)")
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

    // Fetch from GitHub issue
    if (opts.fromGithubIssue) {
      const issueNum = opts.fromGithubIssue;
      let issueJson: string;
      try {
        issueJson = execSync(`gh issue view ${issueNum} --json title,body,labels,assignees`, { encoding: "utf-8", timeout: 15000 });
      } catch (e: any) {
        console.error(chalk.red(`Failed to fetch GitHub issue #${issueNum}. Is gh CLI installed and authenticated?`));
        console.error(chalk.dim(e.message || ""));
        process.exit(1);
      }

      const issue = JSON.parse(issueJson);
      const labels = (issue.labels || []).map((l: any) => l.name || l).join(", ");

      const now = new Date().toISOString();
      const taskId = `task-gh${issueNum}-${now.slice(0, 19).replace(/[T:]/g, "").replace(/-/g, "")}-${uuidv4().slice(0, 6)}`;

      const taskData: Record<string, unknown> = {
        id: taskId,
        template: opts.template,
        prompt: `GitHub Issue #${issueNum}: ${issue.title}\n\n${issue.body || "(no description)"}`,
        project: opts.project,
        model: opts.model,
        priority: opts.priority,
        max_iterations: parseInt(opts.iterations),
        created_at: now,
        params: {
          github_issue: parseInt(issueNum),
          ...(labels ? { labels } : {}),
        },
      };

      const dest = join(inbox, `${taskId}.yaml`);
      writeFileSync(dest, yaml.dump(taskData));

      console.log(chalk.green(`\n  Task Created from GitHub Issue #${issueNum}`));
      console.log(`  ID:       ${chalk.bold(taskId)}`);
      console.log(`  Title:    ${issue.title}`);
      console.log(`  Template: ${opts.template}`);
      console.log(`  Model:    ${opts.model}`);
      if (labels) console.log(`  Labels:   ${labels}`);
      console.log();
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
  .command("run <name>")
  .description("Run a plugin command (e.g. plugin run docker, plugin run cf)")
  .argument("[args...]", "Arguments to pass to the plugin command")
  .action(async (name: string, args: string[]) => {
    const { PluginManager } = await import("./plugins.js");
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);
    const pm = new PluginManager(ws, config as any);
    await pm.loadFromConfig();
    await pm.activateAll();

    const commands = pm.getCommands();
    const entry = commands.get(name);
    if (!entry) {
      const available = [...commands.keys()];
      console.error(chalk.red(`Unknown plugin command: ${name}`));
      if (available.length > 0) {
        console.error(chalk.dim(`Available: ${available.join(", ")}`));
      } else {
        console.error(chalk.dim("No plugin commands registered. Enable plugins in your config."));
      }
      process.exit(1);
    }

    try {
      // Convert positional args to a record for the plugin handler
      const argRecord: Record<string, string> = {};
      args.forEach((a: string, i: number) => { argRecord[`arg${i}`] = a; });
      if (args[0]) argRecord.action = args[0]; // First arg is typically the action
      await entry.handler.action(argRecord);
    } catch (e: any) {
      console.error(chalk.red(`[${entry.pluginName}] ${name} failed: ${e.message}`));
      process.exit(1);
    }

    await pm.deactivateAll();
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
    console.log(`  Directives: ${join(tsDir, "directives/")}`);
    console.log(`  Task inbox: ${join(tsDir, "tasks", "inbox/")}`);
    console.log();
    console.log(`  ${chalk.dim("Global config at ~/.tasksmith is inherited.")}`);
    console.log(`  ${chalk.dim("Project-local settings override global ones.")}`);
    console.log(`  ${chalk.dim("Drop task YAML or JSON files in tasks/inbox/ to run them.")}\n`);
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

    console.log(chalk.bold("\n  Resolution Order"));
    console.log(`    1. ${chalk.dim("--dir flag")}          ${program.opts().dir || chalk.dim("(not set)")}`);
    console.log(`    2. ${chalk.dim("TASKSMITH_DIR env")}   ${process.env.TASKSMITH_DIR || chalk.dim("(not set)")}`);
    console.log(`    3. ${chalk.dim("Project-local")}      ${existsSync(join(process.cwd(), ".tasksmith")) ? chalk.green("found .tasksmith/") : chalk.dim("(not found)")}`);
    console.log(`    4. ${chalk.dim("Global fallback")}    ~/.tasksmith`);
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
      const dryRun = Boolean(opts.dryRun);

      if (!existsSync(wtBaseDir)) {
        console.log(chalk.dim("\n  No worktree directory found. Nothing to clean up.\n"));
        return;
      }

      const activeTasks = new Set(
        existsSync(activeDir)
          ? readdirSync(activeDir).filter(f => isTaskFile(f)).map(f => f.replace(/\.(yaml|yml|json)$/, ""))
          : []
      );

      const entries = readdirSync(wtBaseDir).filter(e =>
        existsSync(join(wtBaseDir, e)) && e.startsWith("task-")
      );

      if (entries.length === 0) {
        console.log(chalk.green("\n  No worktrees found. Clean.\n"));
        return;
      }

      interface StaleWorktree { taskId: string; path: string; branch: string; repoPath: string; reason: string }
      const stale: StaleWorktree[] = [];
      const active: string[] = [];

      for (const taskId of entries) {
        const wtPath = join(wtBaseDir, taskId);
        if (activeTasks.has(taskId)) { active.push(taskId); continue; }

        let reason = "orphaned";
        if (existsSync(join(ws, "tasks", "completed", `${taskId}.yaml`))) reason = "completed";
        else if (existsSync(join(ws, "tasks", "failed", `${taskId}.yaml`))) reason = "failed";

        const branchRes = ss("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath, encoding: "utf-8", stdio: "pipe" });
        const branch = branchRes.status === 0 ? (branchRes.stdout || "").trim() : "unknown";

        const commonRes = ss("git", ["rev-parse", "--git-common-dir"], { cwd: wtPath, encoding: "utf-8", stdio: "pipe" });
        let repoPath = "";
        if (commonRes.status === 0) {
          const gitDir = (commonRes.stdout || "").trim();
          repoPath = gitDir.endsWith("/.git") ? gitDir.slice(0, -5) : gitDir;
        }

        stale.push({ taskId, path: wtPath, branch, repoPath, reason });
      }

      console.log(chalk.bold(`\n  Worktree Cleanup${dryRun ? chalk.yellow(" (dry run)") : ""}\n`));
      if (active.length > 0) {
        console.log(`    ${chalk.green("Active")} (skipping): ${active.length}`);
        for (const id of active) console.log(`      ${chalk.dim("→")} ${id}`);
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

      console.log();
      let removed = 0, failed = 0;
      for (const s of stale) {
        try {
          if (s.repoPath) {
            ss("git", ["worktree", "remove", "--force", s.path], { cwd: s.repoPath, encoding: "utf-8", stdio: "pipe" });
            const branchDel = ss("git", ["branch", "-D", s.branch], { cwd: s.repoPath, encoding: "utf-8", stdio: "pipe" });
          }
          const { rmSync } = await import("node:fs");
          if (existsSync(s.path)) rmSync(s.path, { recursive: true, force: true });
          console.log(`    ${chalk.green("✓")} Removed ${s.taskId} (${s.reason})`);
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

    console.log(chalk.bold("\n  Worker Pool Configuration\n"));
    console.log(`    Concurrency:   ${chalk.bold(engine.concurrency || 1)}`);
    console.log(`    Permission:    ${engine.permissionMode || "supervised"}`);

    // Show task queue counts
    for (const [label, dir] of [["Active", "active"], ["Queued", "inbox"], ["Completed", "completed"], ["Failed", "failed"]] as const) {
      const d = join(ws, "tasks", dir);
      const count = existsSync(d) ? readdirSync(d).filter(f => isTaskFile(f)).length : 0;
      const color = dir === "active" ? chalk.yellow : dir === "failed" ? chalk.red : dir === "completed" ? chalk.green : chalk.white;
      console.log(`    ${label.padEnd(12)} ${color(String(count))}`);
    }

    // Show worktrees on disk
    const wtBaseDir = join(ws, "worktrees");
    if (existsSync(wtBaseDir)) {
      const wtEntries = readdirSync(wtBaseDir).filter(e => e.startsWith("task-"));
      if (wtEntries.length > 0) {
        const activeDir = join(ws, "tasks", "active");
        const activeTasks = new Set(
          existsSync(activeDir)
            ? readdirSync(activeDir).filter(f => isTaskFile(f)).map(f => f.replace(/\.(yaml|yml|json)$/, ""))
            : []
        );
        console.log(chalk.bold(`\n    Worktrees on Disk (${wtEntries.length}):`));
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

    console.log(chalk.dim(`\n    Configure concurrency in tasksmith.yaml:`));
    console.log(chalk.dim("    engine:"));
    console.log(chalk.dim("      concurrency: 3"));
    console.log();
  });

// ── CC-INSTALL / CC-UNINSTALL ─────────────────────────────────────────

function resolveTasksmithBin(ws: string): { command: string; args: string[] } {
  try {
    const bin = execSync("which tasksmith", { encoding: "utf-8", timeout: 5000 }).trim();
    if (bin) return { command: bin, args: ["mcp", "--dir", ws] };
  } catch { /* */ }
  return { command: "npx", args: ["tasksmith-cli", "mcp", "--dir", ws] };
}

program
  .command("cc-install")
  .description("Register TaskSmith as an MCP server with Claude Code")
  .option("--scope <scope>", "Registration scope: user or project", "user")
  .option("--dir <path>", "TaskSmith workspace to use (passed as --dir arg to mcp command)")
  .action((opts) => {
    const scope = opts.scope === "project" ? "project" : "user";
    const ws = resolveWorkspace(opts.dir || program.opts().dir);
    const { command, args } = resolveTasksmithBin(ws);
    const mcpEntry = { command, args };
    const configStr = JSON.stringify(mcpEntry);

    let usedCli = false;
    try {
      execSync(`claude mcp add-json tasksmith '${configStr}' --scope ${scope}`, {
        encoding: "utf-8",
        timeout: 10000,
        stdio: "pipe",
      });
      usedCli = true;
    } catch { /* fall through to file-based */ }

    if (!usedCli) {
      const cfgPath = scope === "user"
        ? join(homedir(), ".claude.json")
        : join(process.cwd(), ".mcp.json");

      let cfg: Record<string, any> = {};
      if (existsSync(cfgPath)) {
        try { cfg = JSON.parse(readFileSync(cfgPath, "utf-8")); } catch { /* */ }
      }
      if (!cfg.mcpServers) cfg.mcpServers = {};
      const existed = !!cfg.mcpServers.tasksmith;
      cfg.mcpServers.tasksmith = mcpEntry;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

      const target = scope === "user" ? "~/.claude.json" : ".mcp.json";
      console.log(existed
        ? chalk.yellow(`\n  ↻ Updated TaskSmith MCP registration in ${target}\n`)
        : chalk.green(`\n  ✓ Registered TaskSmith MCP server in ${target}\n`));
    } else {
      console.log(chalk.green(`\n  ✓ TaskSmith MCP server registered (scope: ${scope})\n`));
    }

    console.log("  Available MCP tools:");
    const tools = [
      "submit_task", "get_task_status", "list_tasks", "cancel_task", "retry_task",
      "search_memory", "store_memory", "list_projects", "queue_status", "health_check",
      "submit_dag", "dag_status", "list_dags",
    ];
    for (const t of tools) console.log(`    ${chalk.cyan("·")} ${t}`);
    console.log();
  });

program
  .command("cc-uninstall")
  .description("Remove TaskSmith MCP server registration from Claude Code")
  .option("--scope <scope>", "Registration scope: user or project", "user")
  .action((opts) => {
    const scope = opts.scope === "project" ? "project" : "user";

    let usedCli = false;
    try {
      execSync(`claude mcp remove tasksmith --scope ${scope}`, {
        encoding: "utf-8",
        timeout: 10000,
        stdio: "pipe",
      });
      usedCli = true;
    } catch { /* fall through to file-based */ }

    if (!usedCli) {
      const cfgPath = scope === "user"
        ? join(homedir(), ".claude.json")
        : join(process.cwd(), ".mcp.json");
      const target = scope === "user" ? "~/.claude.json" : ".mcp.json";

      if (!existsSync(cfgPath)) {
        console.log(chalk.dim(`\n  Nothing to uninstall — ${target} not found.\n`));
        return;
      }

      let cfg: Record<string, any> = {};
      try { cfg = JSON.parse(readFileSync(cfgPath, "utf-8")); } catch { /* */ }

      if (!cfg.mcpServers?.tasksmith) {
        console.log(chalk.dim(`\n  TaskSmith MCP is not registered in ${target}.\n`));
        return;
      }

      delete cfg.mcpServers.tasksmith;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log(chalk.green(`\n  ✓ Removed TaskSmith MCP registration from ${target}\n`));
    } else {
      console.log(chalk.green(`\n  ✓ TaskSmith MCP server removed (scope: ${scope})\n`));
    }
  });

// ── APPROVE / REJECT ────────────────────────────────────────────────

program
  .command("approve <taskId>")
  .description("Approve a task pending human-in-the-loop review")
  .action(async (taskId: string) => {
    const ws = resolveWorkspace(program.opts().dir);
    const approvalDir = join(ws, "tasks", "pending_approval");
    const approvalFile = join(approvalDir, `${taskId}.yaml`);

    if (!existsSync(approvalFile)) {
      console.error(chalk.red(`\n  No pending approval found for ${taskId}\n`));
      console.log(chalk.dim("  Check pending approvals:"));
      if (existsSync(approvalDir)) {
        const pending = readdirSync(approvalDir).filter(f => isTaskFile(f));
        if (pending.length > 0) {
          for (const f of pending) console.log(`    ${chalk.yellow("⏳")} ${f.replace(/\.(yaml|yml|json)$/, "")}`);
        } else {
          console.log(chalk.dim("    (none)"));
        }
      }
      console.log();
      process.exit(1);
    }

    // Write a decision file for the running coordinator to pick up.
    // The coordinator polls for .decision-*.json files and routes them
    // through handleApprovalDecision() to clear timers + in-memory state.
    const decisionFile = join(ws, "tasks", "pending_approval", `.decision-${taskId}.json`);
    writeFileSync(decisionFile, JSON.stringify({ taskId, approved: true, decidedBy: "cli" }));
    console.log(chalk.green(`\n  ✓ Approved ${taskId} — coordinator will pick up the decision\n`));
  });

program
  .command("reject <taskId>")
  .description("Reject a task pending human-in-the-loop review")
  .option("-r, --reason <reason>", "Rejection reason")
  .action(async (taskId: string, opts: { reason?: string }) => {
    const ws = resolveWorkspace(program.opts().dir);
    const approvalFile = join(ws, "tasks", "pending_approval", `${taskId}.yaml`);

    if (!existsSync(approvalFile)) {
      console.error(chalk.red(`\n  No pending approval found for ${taskId}\n`));
      process.exit(1);
    }

    // Write a decision file for the running coordinator to pick up.
    const decisionFile = join(ws, "tasks", "pending_approval", `.decision-${taskId}.json`);
    writeFileSync(decisionFile, JSON.stringify({ taskId, approved: false, decidedBy: `cli${opts.reason ? `: ${opts.reason}` : ""}` }));
    console.log(chalk.red(`\n  ✗ Rejected ${taskId} — coordinator will pick up the decision\n`));
  });

// ── SCHEDULE ────────────────────────────────────────────────────────

program
  .command("schedule")
  .description("Show configured task schedules")
  .action(async () => {
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);
    const schedules = ((config as any).scheduling?.tasks || (config as any).schedules) as Array<Record<string, unknown>> | undefined;

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

// ── METRICS ──────────────────────────────────────────────────────────

program
  .command("metrics")
  .description("Show task execution metrics and cost tracking")
  .option("--json", "Output raw JSON")
  .option("--days <n>", "Show stats for last N days", "30")
  .action(async (opts) => {
    const ws = resolveWorkspace(program.opts().dir);
    const metricsPath = join(ws, "metrics.json");

    if (!existsSync(metricsPath)) {
      console.log(chalk.dim("\n  No metrics data found. Run some tasks first.\n"));
      return;
    }

    const metrics = JSON.parse(readFileSync(metricsPath, "utf-8"));

    if (opts.json) {
      console.log(JSON.stringify(metrics, null, 2));
      return;
    }

    const days = parseInt(opts.days || "30") || 30;
    const cutoff = Date.now() - days * 86400000;
    const recent = (metrics.records || []).filter((r: any) => new Date(r.completedAt).getTime() > cutoff);
    const agg = metrics.aggregates || {};

    console.log(chalk.bold(`\n  TaskSmith Metrics (last ${days} days)\n`));
    console.log(`    Total tasks:     ${chalk.bold(String(agg.totalTasks || 0))}`);
    const rate = agg.successRate || 0;
    const rateColor = rate >= 80 ? chalk.green : rate >= 50 ? chalk.yellow : chalk.red;
    console.log(`    Success rate:    ${rateColor(rate + "%")}`);
    console.log(`    Avg iterations:  ${agg.avgIterations || 0}`);
    console.log(`    Avg duration:    ${Math.round((agg.avgDurationMs || 0) / 1000)}s`);
    console.log(`    Passed:          ${chalk.green(String(agg.successCount || 0))}`);
    console.log(`    Failed:          ${chalk.red(String(agg.failCount || 0))}`);
    if (agg.totalCostUsd > 0) {
      console.log(`    Total cost:      ${chalk.yellow("$" + agg.totalCostUsd.toFixed(4))}`);
      console.log(`    Avg cost/task:   ${chalk.yellow("$" + agg.avgCostUsd.toFixed(4))}`);
    }

    if (Object.keys(agg.byModel || {}).length > 0) {
      console.log(chalk.bold(`\n  By Model\n`));
      for (const [model, stats] of Object.entries(agg.byModel) as [string, any][]) {
        const r = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
        const cost = stats.totalCostUsd > 0 ? `  $${stats.totalCostUsd.toFixed(4)}` : "";
        console.log(`    ${model.padEnd(16)} ${String(stats.total).padStart(4)} tasks  ${String(r).padStart(3)}% pass  ${stats.avgIterations} avg iters${cost}`);
      }
    }

    if (Object.keys(agg.byTemplate || {}).length > 0) {
      console.log(chalk.bold(`\n  By Template\n`));
      for (const [tmpl, stats] of Object.entries(agg.byTemplate) as [string, any][]) {
        const r = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
        const cost = stats.totalCostUsd > 0 ? `  $${stats.totalCostUsd.toFixed(4)}` : "";
        console.log(`    ${tmpl.padEnd(20)} ${String(stats.total).padStart(4)} tasks  ${String(r).padStart(3)}% pass  ${stats.avgIterations} avg iters${cost}`);
      }
    }

    if (Object.keys(agg.byProject || {}).length > 0) {
      console.log(chalk.bold(`\n  By Project\n`));
      for (const [proj, stats] of Object.entries(agg.byProject) as [string, any][]) {
        const r = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
        const cost = stats.totalCostUsd > 0 ? `  $${stats.totalCostUsd.toFixed(4)}` : "";
        console.log(`    ${proj.padEnd(20)} ${String(stats.total).padStart(4)} tasks  ${String(r).padStart(3)}% pass${cost}`);
      }
    }

    // Smart routing savings
    if (agg.totalCostUsd > 0 && Object.keys(agg.byModel || {}).length > 1) {
      const costMultiplier: Record<string, number> = { haiku: 0.04, sonnet: 0.2, opus: 1.0 };
      let hypothetical = 0;
      for (const [model, stats] of Object.entries(agg.byModel) as [string, any][]) {
        if (stats.totalCostUsd <= 0) continue;
        const m = costMultiplier[model];
        hypothetical += (m && m < 1) ? stats.totalCostUsd / m : stats.totalCostUsd;
      }
      const saved = hypothetical - agg.totalCostUsd;
      if (saved > 0.001) {
        const pct = Math.round((saved / hypothetical) * 100);
        console.log(chalk.bold(`\n  Smart Routing Savings\n`));
        console.log(`    Actual cost:     ${chalk.yellow("$" + agg.totalCostUsd.toFixed(4))}`);
        console.log(`    All-opus cost:   ${chalk.dim("$" + hypothetical.toFixed(4))}`);
        console.log(`    Saved:           ${chalk.green("$" + saved.toFixed(4))} (${pct}%)`);
      }
    }

    // Recent failures
    const failures = recent.filter((r: any) => !r.success).slice(-5);
    if (failures.length > 0) {
      console.log(chalk.bold(`\n  Recent Failures\n`));
      for (const f of failures) {
        console.log(`    ${chalk.red("✗")} ${f.taskId}  ${f.template}  ${f.model}  ${(f.error || "").slice(0, 60)}`);
      }
    }

    console.log(chalk.dim(`\n  Data file: ${metricsPath}\n`));
  });

// ── INSIGHTS ─────────────────────────────────────────────────────────

program
  .command("insights")
  .description("Analyze task history for patterns and actionable observations")
  .option("--days <n>", "Analyze last N days", "30")
  .option("--json", "Output raw JSON")
  .action(async (opts) => {
    const ws = resolveWorkspace(program.opts().dir);
    const metricsPath = join(ws, "metrics.json");

    if (!existsSync(metricsPath)) {
      console.log(chalk.dim("\n  No metrics data found. Run some tasks first.\n"));
      return;
    }

    const metrics = JSON.parse(readFileSync(metricsPath, "utf-8"));
    const days = parseInt(opts.days || "30") || 30;
    const cutoff = Date.now() - days * 86400000;
    const records = (metrics.records || []).filter((r: any) => new Date(r.completedAt).getTime() > cutoff);

    if (records.length < 3) {
      console.log(chalk.dim("\n  Not enough data to generate insights. Run more tasks!\n"));
      return;
    }

    type Insight = { type: string; category: string; message: string };
    const insights: Insight[] = [];

    // Model performance comparison
    const byModel: Record<string, any[]> = {};
    for (const r of records) { (byModel[r.model] ||= []).push(r); }
    if (Object.keys(byModel).length > 1) {
      let bestModel = "", bestRate = -1, worstModel = "", worstRate = 101;
      for (const [model, recs] of Object.entries(byModel)) {
        if (recs.length < 2) continue;
        const rate = recs.filter((r: any) => r.success).length / recs.length;
        if (rate > bestRate) { bestRate = rate; bestModel = model; }
        if (rate < worstRate) { worstRate = rate; worstModel = model; }
      }
      if (bestModel && worstModel && bestModel !== worstModel && bestRate - worstRate > 0.15) {
        insights.push({ type: "neutral", category: "model", message: `${bestModel} succeeds ${Math.round(bestRate * 100)}% vs ${worstModel} at ${Math.round(worstRate * 100)}% — consider routing more work to ${bestModel}` });
      }
    }

    // Template failure patterns
    const byTemplate: Record<string, any[]> = {};
    for (const r of records) { (byTemplate[r.template] ||= []).push(r); }
    for (const [template, recs] of Object.entries(byTemplate)) {
      if (recs.length < 3) continue;
      const failRate = recs.filter((r: any) => !r.success).length / recs.length;
      if (failRate > 0.5) {
        insights.push({ type: "negative", category: "template", message: `"${template}" fails ${Math.round(failRate * 100)}% of the time (${recs.length} tasks) — review prompts or validation commands` });
      } else if (failRate === 0 && recs.length >= 5) {
        insights.push({ type: "positive", category: "template", message: `"${template}" has a perfect record: ${recs.length} tasks, 0 failures` });
      }
    }

    // Iteration bloat
    const avgIter = records.reduce((s: number, r: any) => s + r.iterations, 0) / records.length;
    const highIter = records.filter((r: any) => r.iterations > avgIter * 2 && r.iterations > 3);
    if (highIter.length > 0) {
      const pct = Math.round((highIter.length / records.length) * 100);
      insights.push({ type: "negative", category: "efficiency", message: `${highIter.length} tasks (${pct}%) needed >2x avg iterations — prompts may be ambiguous or validation too strict` });
    }

    // Cost outliers
    const withCost = records.filter((r: any) => r.costUsd > 0);
    if (withCost.length >= 5) {
      const costs = withCost.map((r: any) => r.costUsd).sort((a: number, b: number) => a - b);
      const median = costs[Math.floor(costs.length / 2)];
      const expensive = withCost.filter((r: any) => r.costUsd > median * 3);
      if (expensive.length > 0) {
        const top = expensive.sort((a: any, b: any) => b.costUsd - a.costUsd)[0];
        insights.push({ type: "negative", category: "cost", message: `${expensive.length} tasks cost >3x median ($${median.toFixed(4)}). Most expensive: ${top.taskId} at $${top.costUsd.toFixed(4)}` });
      }
    }

    // Trend
    if (records.length >= 10) {
      const sorted = [...records].sort((a: any, b: any) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime());
      const half = Math.floor(sorted.length / 2);
      const firstRate = sorted.slice(0, half).filter((r: any) => r.success).length / half;
      const secondRate = sorted.slice(half).filter((r: any) => r.success).length / (sorted.length - half);
      const delta = secondRate - firstRate;
      if (Math.abs(delta) > 0.1) {
        insights.push({ type: delta > 0 ? "positive" : "negative", category: "trend", message: `Success rate is ${delta > 0 ? "improving" : "declining"}: ${Math.round(firstRate * 100)}% → ${Math.round(secondRate * 100)}%` });
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(insights, null, 2));
      return;
    }

    console.log(chalk.bold(`\n  TaskSmith Insights (last ${days} days)\n`));
    if (insights.length === 0) {
      console.log(chalk.dim("    No notable patterns detected.\n"));
      return;
    }
    for (const insight of insights) {
      const icon = insight.type === "positive" ? chalk.green("▲") : insight.type === "negative" ? chalk.red("▼") : chalk.yellow("●");
      console.log(`    ${icon} ${insight.message}`);
    }
    console.log();
  });

// ── COSTS ─────────────────────────────────────────────────────────

program
  .command("costs")
  .description("Show cost dashboard from JSONL task logs")
  .option("--days <n>", "Only show costs from last N days")
  .option("--period <period>", "Group cost history by: day|week|month", "day")
  .option("--json", "Output raw JSON")
  .action(async (opts) => {
    const ws = resolveWorkspace(program.opts().dir);
    const config = loadConfig(ws);
    const logsDir = join(ws, "logs");

    if (!existsSync(logsDir)) {
      console.log(chalk.dim("\n  No logs directory found. Run some tasks first.\n"));
      return;
    }

    const days = opts.days ? parseInt(opts.days) || 0 : 0;
    const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;

    type TaskRecord = {
      taskId: string;
      template: string;
      model: string;
      project: string;
      status: string;
      totalCostUsd: number;
      iterationsUsed: number;
      ts: string;
    };

    const records: TaskRecord[] = [];

    let files: string[];
    try {
      files = readdirSync(logsDir).filter((f) => f.startsWith("task-") && f.endsWith(".jsonl"));
    } catch {
      console.log(chalk.dim("\n  Could not read logs directory.\n"));
      return;
    }

    for (const file of files) {
      const filePath = join(logsDir, file);
      let startEvent: Record<string, any> | null = null;
      let endEvent: Record<string, any> | null = null;

      try {
        const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.event === "task_start") startEvent = entry;
            if (entry.event === "task_end") endEvent = entry;
          } catch {
            // skip malformed lines
          }
        }
      } catch {
        continue;
      }

      if (!endEvent) continue;

      if (cutoff > 0 && endEvent.ts) {
        const ts = new Date(endEvent.ts).getTime();
        if (ts < cutoff) continue;
      }

      records.push({
        taskId: endEvent.task || file.replace(".jsonl", ""),
        template: startEvent?.template || "",
        model: startEvent?.model || endEvent.model || "",
        project: startEvent?.project || endEvent.project || "",
        status: endEvent.status || "",
        totalCostUsd: endEvent.total_cost_usd || 0,
        iterationsUsed: endEvent.iterations_used || 0,
        ts: endEvent.ts || "",
      });
    }

    if (opts.json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }

    if (records.length === 0) {
      const suffix = days > 0 ? ` in the last ${days} days` : "";
      console.log(chalk.dim(`\n  No task cost data found${suffix}.\n`));
      return;
    }

    const totalCost = records.reduce((s, r) => s + r.totalCostUsd, 0);
    const avgCost = totalCost / records.length;

    const label = days > 0 ? `last ${days} days` : "all time";
    console.log(chalk.bold(`\n  TaskSmith Cost Dashboard (${label})\n`));
    console.log(`    Total spend:     ${chalk.yellow("$" + totalCost.toFixed(4))}`);
    console.log(`    Tasks:           ${chalk.bold(String(records.length))}`);
    console.log(`    Avg cost/task:   ${chalk.yellow("$" + avgCost.toFixed(4))}`);

    // By model
    const byModel: Record<string, { tasks: number; totalCost: number }> = {};
    for (const r of records) {
      const key = r.model || "unknown";
      (byModel[key] ||= { tasks: 0, totalCost: 0 }).tasks++;
      byModel[key].totalCost += r.totalCostUsd;
    }
    if (Object.keys(byModel).length > 0) {
      console.log(chalk.bold(`\n  By Model\n`));
      console.log(`    ${"Model".padEnd(20)} ${"Tasks".padStart(6)}  ${"Total Cost".padStart(12)}  ${"Avg Cost".padStart(10)}`);
      console.log(`    ${"─".repeat(54)}`);
      for (const [model, s] of Object.entries(byModel).sort((a, b) => b[1].totalCost - a[1].totalCost)) {
        const avg = s.totalCost / s.tasks;
        console.log(`    ${model.padEnd(20)} ${String(s.tasks).padStart(6)}  ${chalk.yellow(("$" + s.totalCost.toFixed(4)).padStart(12))}  ${chalk.dim(("$" + avg.toFixed(4)).padStart(10))}`);
      }
    }

    // By project
    const byProject: Record<string, { tasks: number; totalCost: number }> = {};
    for (const r of records) {
      const key = r.project || "unknown";
      (byProject[key] ||= { tasks: 0, totalCost: 0 }).tasks++;
      byProject[key].totalCost += r.totalCostUsd;
    }
    if (Object.keys(byProject).length > 0) {
      console.log(chalk.bold(`\n  By Project\n`));
      console.log(`    ${"Project".padEnd(24)} ${"Tasks".padStart(6)}  ${"Total Cost".padStart(12)}`);
      console.log(`    ${"─".repeat(46)}`);
      for (const [proj, s] of Object.entries(byProject).sort((a, b) => b[1].totalCost - a[1].totalCost)) {
        console.log(`    ${proj.padEnd(24)} ${String(s.tasks).padStart(6)}  ${chalk.yellow(("$" + s.totalCost.toFixed(4)).padStart(12))}`);
      }
    }

    // Top 5 most expensive tasks
    const top5 = [...records].sort((a, b) => b.totalCostUsd - a.totalCostUsd).slice(0, 5);
    if (top5.length > 0) {
      console.log(chalk.bold(`\n  Top 5 Most Expensive Tasks\n`));
      console.log(`    ${"Task ID".padEnd(36)} ${"Cost".padStart(10)}  ${"Model".padEnd(12)}  ${"Iters".padStart(5)}`);
      console.log(`    ${"─".repeat(68)}`);
      for (const r of top5) {
        console.log(`    ${r.taskId.padEnd(36)} ${chalk.yellow(("$" + r.totalCostUsd.toFixed(4)).padStart(10))}  ${r.model.padEnd(12)}  ${String(r.iterationsUsed).padStart(5)}`);
      }
    }

    // ── Cost History (by period) ───────────────────────────────────
    const period = (opts.period || "day") as string;

    function getPeriodKey(ts: string): string {
      if (!ts) return "unknown";
      const d = new Date(ts);
      if (isNaN(d.getTime())) return "unknown";
      if (period === "month") return d.toISOString().slice(0, 7);
      if (period === "week") {
        const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const dow = date.getUTCDay() || 7;
        date.setUTCDate(date.getUTCDate() + 4 - dow);
        const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
        return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
      }
      return d.toISOString().slice(0, 10);
    }

    type PeriodBucket = { tasks: number; passed: number; failed: number; cost: number };
    const byPeriod: Record<string, PeriodBucket> = {};
    for (const r of records) {
      const key = getPeriodKey(r.ts);
      (byPeriod[key] ||= { tasks: 0, passed: 0, failed: 0, cost: 0 });
      byPeriod[key].tasks++;
      byPeriod[key].cost += r.totalCostUsd;
      if (r.status === "completed") byPeriod[key].passed++;
      else byPeriod[key].failed++;
    }

    const sortedPeriods = Object.keys(byPeriod).filter((k) => k !== "unknown").sort();
    if (byPeriod["unknown"]) sortedPeriods.push("unknown");

    console.log(chalk.bold(`\n  Cost History (by ${period})\n`));
    console.log(
      `    ${"Period".padEnd(12)} ${"Tasks".padStart(6)}  ${"Passed".padStart(6)}  ${"Failed".padStart(6)}  ${"Cost".padStart(12)}  Trend`
    );
    console.log(`    ${"─".repeat(57)}`);

    let histTasks = 0, histPassed = 0, histFailed = 0, histCost = 0;
    let prevCost: number | null = null;

    for (const key of sortedPeriods) {
      const b = byPeriod[key];
      histTasks += b.tasks;
      histPassed += b.passed;
      histFailed += b.failed;
      histCost += b.cost;

      let trend = "  ";
      if (prevCost !== null) {
        if (prevCost === 0) {
          trend = b.cost > 0 ? chalk.red("↑") : chalk.dim("→");
        } else {
          const ratio = (b.cost - prevCost) / prevCost;
          if (ratio > 0.1) trend = chalk.red("↑");
          else if (ratio < -0.1) trend = chalk.green("↓");
          else trend = chalk.dim("→");
        }
      }
      prevCost = b.cost;

      console.log(
        `    ${key.padEnd(12)} ${String(b.tasks).padStart(6)}  ${String(b.passed).padStart(6)}  ${String(b.failed).padStart(6)}  ${chalk.yellow(("$" + b.cost.toFixed(4)).padStart(12))}  ${trend}`
      );
    }

    console.log(`    ${"─".repeat(57)}`);
    console.log(
      `    ${"Total".padEnd(12)} ${String(histTasks).padStart(6)}  ${String(histPassed).padStart(6)}  ${String(histFailed).padStart(6)}  ${chalk.yellow(("$" + histCost.toFixed(4)).padStart(12))}`
    );

    // ── Budget Status ──────────────────────────────────────────────
    const budget = config.taskDefaults?.budget;
    const limits: Array<{ label: string; limitUsd: number; spentUsd: number }> = [];

    if (budget && (budget.dailyUsd > 0 || budget.weeklyUsd > 0 || budget.monthlyUsd > 0)) {
      const warnAt = budget.warnAtPercent ?? 80;

      // Compute current period keys
      const now = new Date();
      const todayKey = now.toISOString().slice(0, 10);
      const todayMonthKey = now.toISOString().slice(0, 7);

      // ISO week key for today
      const isoDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const dow = isoDate.getUTCDay() || 7;
      isoDate.setUTCDate(isoDate.getUTCDate() + 4 - dow);
      const yearStart = new Date(Date.UTC(isoDate.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil(((isoDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
      const todayWeekKey = `${isoDate.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;

      if (budget.dailyUsd > 0) {
        const spent = records.filter((r) => r.ts.startsWith(todayKey)).reduce((s, r) => s + r.totalCostUsd, 0);
        limits.push({ label: "Daily", limitUsd: budget.dailyUsd, spentUsd: spent });
      }
      if (budget.weeklyUsd > 0) {
        const spent = records.filter((r) => getPeriodKey(r.ts) === todayWeekKey).reduce((s, r) => s + r.totalCostUsd, 0);
        limits.push({ label: "Weekly", limitUsd: budget.weeklyUsd, spentUsd: spent });
      }
      if (budget.monthlyUsd > 0) {
        const spent = records.filter((r) => r.ts.startsWith(todayMonthKey)).reduce((s, r) => s + r.totalCostUsd, 0);
        limits.push({ label: "Monthly", limitUsd: budget.monthlyUsd, spentUsd: spent });
      }

      if (limits.length > 0) {
        console.log(chalk.bold(`\n  Budget Status\n`));
        console.log(`    ${"Period".padEnd(10)} ${"Limit".padStart(10)}  ${"Spent".padStart(10)}  ${"Remaining".padStart(10)}  Status`);
        console.log(`    ${"─".repeat(54)}`);
        for (const { label, limitUsd, spentUsd } of limits) {
          const remaining = limitUsd - spentUsd;
          const pct = (spentUsd / limitUsd) * 100;
          let status: string;
          if (pct >= 100) {
            status = chalk.red("✗ Over");
          } else if (pct >= warnAt) {
            status = chalk.yellow("⚠ Warning");
          } else {
            status = chalk.green("✓ OK");
          }
          console.log(
            `    ${label.padEnd(10)} ${chalk.dim(("$" + limitUsd.toFixed(2)).padStart(10))}  ${chalk.yellow(("$" + spentUsd.toFixed(4)).padStart(10))}  ${(remaining >= 0 ? chalk.green : chalk.red)(("$" + remaining.toFixed(4)).padStart(10))}  ${status}`
          );
        }
      }
    }

    // ── Spend Forecast ────────────────────────────────────────────────
    const forecastNow = new Date();
    const allDailyCostMap: Record<string, number> = {};
    for (const r of records) {
      const dayKey = r.ts ? r.ts.slice(0, 10) : null;
      if (!dayKey || dayKey === "unknown") continue;
      allDailyCostMap[dayKey] = (allDailyCostMap[dayKey] || 0) + r.totalCostUsd;
    }

    const dayCostKeys = Object.keys(allDailyCostMap).sort();

    if (dayCostKeys.length > 0) {
      console.log(chalk.bold(`\n  Spend Forecast\n`));

      const oldestDate = new Date(dayCostKeys[0] + "T00:00:00Z");
      const daySpan = Math.min(
        14,
        Math.floor((forecastNow.getTime() - oldestDate.getTime()) / 86400000) + 1
      );

      if (daySpan < 3) {
        console.log(chalk.dim("    Insufficient data for forecast (need 3+ days)\n"));
      } else {
        // Build window ending today, filling gaps with $0
        const fcWindow: number[] = [];
        for (let i = daySpan - 1; i >= 0; i--) {
          const d = new Date(
            Date.UTC(forecastNow.getUTCFullYear(), forecastNow.getUTCMonth(), forecastNow.getUTCDate() - i)
          );
          fcWindow.push(allDailyCostMap[d.toISOString().slice(0, 10)] ?? 0);
        }

        // Weighted moving average: weight = index + 1 (most recent = highest)
        const totalWeight = fcWindow.reduce((s, _, i) => s + (i + 1), 0);
        const dailyRate = fcWindow.reduce((s, cost, i) => s + cost * (i + 1), 0) / totalWeight;

        // Current week spend (ISO week, Mon-based)
        const isoDay = forecastNow.getUTCDay() || 7;
        const weekStartDate = new Date(
          Date.UTC(forecastNow.getUTCFullYear(), forecastNow.getUTCMonth(), forecastNow.getUTCDate() - isoDay + 1)
        );
        const weekStartKey = weekStartDate.toISOString().slice(0, 10);
        const todayKeyFc = forecastNow.toISOString().slice(0, 10);
        const thisWeekSpend = records
          .filter((r) => r.ts >= weekStartKey && r.ts.slice(0, 10) <= todayKeyFc)
          .reduce((s, r) => s + r.totalCostUsd, 0);
        const daysLeftInWeek = 7 - isoDay;
        const projWeek = thisWeekSpend + daysLeftInWeek * dailyRate;

        // Current month spend
        const monthPrefixFc = forecastNow.toISOString().slice(0, 7);
        const thisMonthSpend = records
          .filter((r) => r.ts.startsWith(monthPrefixFc))
          .reduce((s, r) => s + r.totalCostUsd, 0);
        const daysInMonthFc = new Date(
          Date.UTC(forecastNow.getUTCFullYear(), forecastNow.getUTCMonth() + 1, 0)
        ).getUTCDate();
        const daysLeftInMonth = daysInMonthFc - forecastNow.getUTCDate();
        const projMonth = thisMonthSpend + daysLeftInMonth * dailyRate;
        const proj30 = dailyRate * 30;

        const budgetFc = config.taskDefaults?.budget;
        const monthlyLimit = budgetFc?.monthlyUsd || 0;
        const dailyLimit = budgetFc?.dailyUsd || 0;
        const warnAtFc = budgetFc?.warnAtPercent ?? 80;

        console.log(`    Daily run rate:          ${chalk.yellow("$" + dailyRate.toFixed(4) + "/day")}`);
        console.log(`    Projected this week:     ${chalk.yellow("$" + projWeek.toFixed(4))}`);

        if (monthlyLimit > 0) {
          const pct = (projMonth / monthlyLimit) * 100;
          const projColor = pct >= 100 ? chalk.red : pct >= warnAtFc ? chalk.yellow : chalk.green;
          const projIcon = pct >= 100 ? " ⚠" : pct >= warnAtFc ? " ⚠" : " ✓";
          console.log(`    Projected this month:    ${projColor("$" + projMonth.toFixed(4) + projIcon)}`);
        } else {
          console.log(`    Projected this month:    ${chalk.yellow("$" + projMonth.toFixed(4))}`);
        }

        console.log(`    Projected next 30 days:  ${chalk.yellow("$" + proj30.toFixed(4))}`);

        if (dailyLimit > 0 && dailyRate > 0) {
          const daysUntilExhausted = dailyLimit / dailyRate;
          const exhaustColor =
            daysUntilExhausted < 1 ? chalk.red : daysUntilExhausted < 3 ? chalk.yellow : chalk.green;
          console.log(
            `    Days until daily budget exhausted: ${exhaustColor(daysUntilExhausted.toFixed(1))}`
          );
        }

        if (monthlyLimit > 0) {
          const pct = (projMonth / monthlyLimit) * 100;
          const indicator = pct >= 100 ? chalk.red("⚠") : pct >= warnAtFc ? chalk.yellow("⚠") : chalk.green("✓");
          console.log(
            `    Monthly budget status:   ${indicator} ${pct.toFixed(0)}% of $${monthlyLimit.toFixed(2)} limit projected`
          );
        }
      }
    }

    console.log();
  });

// ── PARSE & RUN ────────────────────────────────────────────────────

program.parse();
