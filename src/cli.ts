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
      const dryRun = opts.dryRun && !opts.cleanup;

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

    // Read task, move to inbox for pickup by running engine
    const taskData = readFileSync(approvalFile, "utf-8");
    const task = yaml.load(taskData) as Record<string, unknown>;
    task.status = "pending";
    (task as any)._approvedBy = "cli";
    const inboxFile = join(ws, "tasks", "inbox", `${taskId}.yaml`);
    writeFileSync(inboxFile, yaml.dump(task));
    unlinkSync(approvalFile);
    console.log(chalk.green(`\n  ✓ Approved ${taskId} — moved to inbox for execution\n`));
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

    const taskData = readFileSync(approvalFile, "utf-8");
    const task = yaml.load(taskData) as Record<string, unknown>;
    task.status = "failed";
    task.error = `Rejected via CLI${opts.reason ? `: ${opts.reason}` : ""}`;
    task.completedAt = new Date().toISOString();
    const failFile = join(ws, "tasks", "failed", `${taskId}.yaml`);
    writeFileSync(failFile, yaml.dump(task));
    unlinkSync(approvalFile);
    console.log(chalk.red(`\n  ✗ Rejected ${taskId}\n`));
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

// ── PARSE & RUN ────────────────────────────────────────────────────

program.parse();
