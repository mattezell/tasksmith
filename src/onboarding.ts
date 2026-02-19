/**
 * TaskSmith Onboarding Wizard
 *
 * Interactive setup. Each step re-runnable: `tasksmith setup --step comms`
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { scaffoldWorkspace, saveConfig, backupConfig, DEFAULT_CONFIG } from "./config.js";
import { OUTBOUND_REGISTRY } from "./providers/comms/providers.js";
import type { TaskSmithConfig, Notification, Priority } from "./types.js";

function header(text: string) {
  console.log(chalk.blue(`\n  ═══ ${text} ═══\n`));
}

function step(n: number, total: number, text: string) {
  console.log(`\n  ${chalk.cyan(`[${n}/${total}]`)} ${chalk.bold(text)}`);
  console.log(chalk.dim("  " + "─".repeat(48)));
}

// =============================================================================
// PARSE EXISTING SETTINGS
// =============================================================================

function parseSoulDefaults(ws: string): Record<string, any> {
  const soulPath = join(ws, "directives", "SOUL.md");
  if (!existsSync(soulPath)) return {};
  const content = readFileSync(soulPath, "utf-8");
  const defaults: Record<string, any> = {};

  const styleMatch = content.match(/- Style: (\w+)/);
  if (styleMatch) defaults.style = styleMatch[1];

  const approachMatch = content.match(/- Approach: ([\w-]+)/);
  if (approachMatch) defaults.philosophy = approachMatch[1];

  defaults.testsFirst = content.includes("Tests first");
  defaults.minComments = content.includes("Self-documenting code");

  if (content.includes("ask before proceeding")) defaults.uncertain = "ask first";
  else if (content.includes("make a reasonable choice")) defaults.uncertain = "try then check";

  const antiSection = content.match(/## Anti-Patterns\n((?:- .+\n?)+)/);
  if (antiSection) {
    defaults.anti = antiSection[1].split("\n").filter((l: string) => l.startsWith("- ")).map((l: string) => l.replace(/^- /, "")).join(", ");
  }

  return defaults;
}

function parseUserDefaults(ws: string): Record<string, string> {
  const userPath = join(ws, "directives", "USER.md");
  if (!existsSync(userPath)) return {};
  const content = readFileSync(userPath, "utf-8");
  const defaults: Record<string, string> = {};

  const nameMatch = content.match(/- Name: (.+)/);
  if (nameMatch) defaults.name = nameMatch[1].trim();

  const roleMatch = content.match(/- Role: (.+)/);
  if (roleMatch) defaults.role = roleMatch[1].trim();

  const langsMatch = content.match(/- Languages: (.+)/);
  if (langsMatch) defaults.langs = langsMatch[1].trim();

  const gpuMatch = content.match(/- Local GPU: (.+)/);
  if (gpuMatch) defaults.gpu = gpuMatch[1].trim();

  return defaults;
}

// =============================================================================
// STEPS
// =============================================================================

async function stepPrereqs(): Promise<boolean> {
  step(1, 9, "Prerequisites Check");
  const checks: [string, string][] = [["Claude Code CLI", "claude --version"], ["Node.js 18+", "node --version"], ["git", "git --version"]];
  const optional: [string, string][] = [["Ollama", "ollama --version"], ["Docker", "docker --version"]];

  let ok = true;
  for (const [name, cmd] of checks) {
    try {
      const v = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim().split("\n")[0];
      console.log(`    ${chalk.green("✓")} ${name}: ${v}`);
    } catch {
      console.log(`    ${chalk.red("✗")} ${name}: NOT FOUND`);
      ok = false;
    }
  }
  console.log();
  for (const [name, cmd] of optional) {
    try {
      const v = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim().split("\n")[0];
      console.log(`    ${chalk.green("✓")} ${name}: ${v}`);
    } catch {
      console.log(`    ${chalk.dim("○")} ${name}: not installed (optional)`);
    }
  }
  return ok;
}

async function stepInit(ws: string) {
  step(2, 9, "Initialize Workspace");
  scaffoldWorkspace(ws);
  console.log(`    ${chalk.green("✓")} Workspace at ${ws}`);
}

async function stepSoul(ws: string) {
  step(3, 9, "SOUL.md — How Claude Works For You");

  const prev = parseSoulDefaults(ws);
  const answers = await inquirer.prompt([
    { name: "style", message: "Communication style:", type: "list", choices: ["concise", "balanced", "verbose"], default: prev.style || "concise" },
    { name: "philosophy", message: "Code philosophy:", type: "list", choices: ["pragmatic", "principled", "move-fast"], default: prev.philosophy || "pragmatic" },
    { name: "testsFirst", message: "Test-first approach?", type: "confirm", default: prev.testsFirst ?? true },
    { name: "minComments", message: "Minimal comments (self-documenting code)?", type: "confirm", default: prev.minComments ?? true },
    { name: "uncertain", message: "When uncertain:", type: "list", choices: ["ask first", "try then check"], default: prev.uncertain || "try then check" },
    { name: "anti", message: "Anti-patterns (comma-separated):", default: prev.anti || "over-engineering, unnecessary abstractions, premature optimization" },
  ]);

  const soul = `# Soul

## Communication
- Style: ${answers.style}
- Lead with outcomes, explain after if needed
- Don't ask permission on obvious next steps

## Code Philosophy
- Approach: ${answers.philosophy}
- ${answers.testsFirst ? "Tests first, then implementation" : "Implementation, then tests"}
- ${answers.minComments ? "Self-documenting code. Minimize comments." : "Include comments for complex logic."}
- Simple readable solutions over clever ones
- When uncertain: ${answers.uncertain === "ask first" ? "ask before proceeding" : "make a reasonable choice, proceed, note the assumption"}

## Anti-Patterns
${answers.anti.split(",").map((p: string) => `- ${p.trim()}`).join("\n")}

## Output
- Production-quality by default
- Include error handling
- Follow project's existing patterns
`;

  mkdirSync(join(ws, "directives"), { recursive: true });
  writeFileSync(join(ws, "directives", "SOUL.md"), soul);
  console.log(`    ${chalk.green("✓")} SOUL.md created`);
}

async function stepUser(ws: string) {
  step(4, 9, "USER.md — About You");

  const prev = parseUserDefaults(ws);
  const answers = await inquirer.prompt([
    { name: "name", message: "Name/handle:", default: prev.name || "" },
    { name: "role", message: "Role:", default: prev.role || "software architect" },
    { name: "langs", message: "Primary languages:", default: prev.langs || "TypeScript, Python, Go" },
    { name: "gpu", message: "GPU for local inference (or 'none'):", default: prev.gpu || "none" },
  ]);

  const userMd = `# User Profile

## Identity
- Name: ${answers.name}
- Role: ${answers.role}

## Technical
- Languages: ${answers.langs}
- Local GPU: ${answers.gpu}

## Preferences
- ADHD-aware: needs self-documenting systems, easy re-entry after gaps
- Prefers understanding over abstraction
`;

  writeFileSync(join(ws, "directives", "USER.md"), userMd);
  console.log(`    ${chalk.green("✓")} USER.md created`);
}

async function stepComms(ws: string, config: TaskSmithConfig): Promise<TaskSmithConfig> {
  step(5, 9, "Communication");

  const isEnabled = (p: string) => config.communication.outbound.find(e => e.provider === p)?.enabled ?? false;
  const { outbound } = await inquirer.prompt([{
    name: "outbound",
    message: "Outbound notifications (select all that apply):",
    type: "checkbox",
    choices: [
      { name: "Discord Webhook", value: "discord_webhook", checked: isEnabled("discord_webhook") },
      { name: "ntfy.sh push notifications", value: "ntfy", checked: isEnabled("ntfy") },
      { name: "Slack Webhook", value: "slack_webhook", checked: isEnabled("slack_webhook") },
      { name: "Email (SMTP)", value: "email", checked: isEnabled("email") },
      { name: "Generic Webhook", value: "webhook_generic", checked: isEnabled("webhook_generic") },
    ],
  }]);

  // Disable all first
  for (const e of config.communication.outbound) e.enabled = false;

  for (const provider of outbound) {
    const entry = config.communication.outbound.find(e => e.provider === provider);
    if (!entry) continue;
    entry.enabled = true;

    if (provider === "discord_webhook") {
      const { url } = await inquirer.prompt([{ name: "url", message: "Discord webhook URL:", default: entry.config.webhookUrl || "" }]);
      entry.config.webhookUrl = url;
    } else if (provider === "ntfy") {
      const a = await inquirer.prompt([
        { name: "topic", message: "ntfy topic:", default: entry.config.topic || "tasksmith" },
        { name: "server", message: "ntfy server:", default: entry.config.server || "https://ntfy.sh" },
      ]);
      entry.config.topic = a.topic;
      entry.config.server = a.server;
    } else if (provider === "slack_webhook") {
      const { url } = await inquirer.prompt([{ name: "url", message: "Slack webhook URL:", default: entry.config.webhookUrl || "" }]);
      entry.config.webhookUrl = url;
    }
  }

  // Inbound
  console.log(`\n    File drop is always enabled (YAML in tasks/inbox/)`);

  const discordBot = config.communication.inbound.find(e => e.provider === "discord_bot")!;
  const { enableDiscord } = await inquirer.prompt([
    { name: "enableDiscord", message: "Enable Discord bot (bidirectional)?", type: "confirm", default: discordBot.enabled },
  ]);
  if (enableDiscord) {
    const a = await inquirer.prompt([
      { name: "token", message: "Bot token:", default: discordBot.config.botToken || "" },
      { name: "channel", message: "Channel ID (or empty for all):", default: discordBot.config.channelId || "" },
    ]);
    discordBot.enabled = true;
    discordBot.config.botToken = a.token;
    discordBot.config.channelId = a.channel;
  } else {
    discordBot.enabled = false;
  }

  const restApi = config.communication.inbound.find(e => e.provider === "rest_api")!;
  const { enableApi } = await inquirer.prompt([
    { name: "enableApi", message: "Enable REST API (port 8420)?", type: "confirm", default: restApi.enabled },
  ]);
  config.communication.inbound.find(e => e.provider === "rest_api")!.enabled = enableApi;

  console.log(`    ${chalk.green("✓")} Communication configured`);
  return config;
}

async function stepModels(ws: string, config: TaskSmithConfig): Promise<TaskSmithConfig> {
  step(6, 9, "Model Routing");

  let ollamaModels: string[] = [];
  try {
    const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    const data = await r.json() as { models: { name: string }[] };
    ollamaModels = data.models.map(m => m.name);
  } catch { /* */ }

  if (ollamaModels.length) {
    console.log(`    ${chalk.green("✓")} Ollama detected: ${ollamaModels.length} model(s)`);
    for (const m of ollamaModels.slice(0, 8)) console.log(`      - ${m}`);

    const ollamaEntry = config.models.providers.find(e => e.provider === "ollama");
    if (ollamaEntry) ollamaEntry.enabled = true;

    const ollamaEnabled = ollamaEntry?.enabled ?? true;
    const { useLocal } = await inquirer.prompt([
      { name: "useLocal", message: "Use local models for summarization & embeddings?", type: "confirm", default: ollamaEnabled },
    ]);
    if (useLocal) {
      const a = await inquirer.prompt([
        { name: "embed", message: "Embedding model:", default: config.models.routing.embeddings?.model || "nomic-embed-text" },
        { name: "summarize", message: "Summarize model:", default: config.models.routing.memory_summarize?.model || "qwen3:14b" },
      ]);
      config.models.routing.embeddings.model = a.embed;
      config.models.routing.memory_summarize.model = a.summarize;
    }
  } else {
    console.log(`    ${chalk.dim("○ Ollama not detected. Cloud-only mode.")}`);
  }

  console.log(`    ${chalk.green("✓")} Model routing configured`);
  return config;
}

async function stepMemory(ws: string, config: TaskSmithConfig): Promise<TaskSmithConfig> {
  step(7, 9, "Memory System");
  console.log("    Baseline (always on): markdown hot + JSONL warm");

  // Init files
  const mem = join(ws, "directives", "MEMORY.md");
  if (!existsSync(mem)) {
    writeFileSync(mem, `# Memory\n\n## System\n- TaskSmith initialized: ${new Date().toISOString().split("T")[0]}\n`);
  }
  const conv = join(ws, "directives", "CONVENTIONS.md");
  if (!existsSync(conv)) {
    writeFileSync(conv, "# Conventions\n\n- Prefer explicit over implicit\n- Error handling is not optional\n- Functions should do one thing\n");
  }

  console.log(`    ${chalk.green("✓")} Memory configured`);
  return config;
}

async function stepEngine(ws: string, config: TaskSmithConfig): Promise<TaskSmithConfig> {
  step(8, 9, "Engine & Permissions");
  console.log("    Controls how autonomous Claude Code is during task execution.\n");

  if (!config.engine) (config as any).engine = {};

  const currentMode = config.engine?.permissionMode || "supervised";

  const { mode } = await inquirer.prompt([
    {
      name: "mode",
      message: "Permission mode:",
      type: "list",
      default: currentMode,
      choices: [
        { name: "supervised  — tasks may stall on permission prompts (safest)", value: "supervised" },
        { name: "autonomous  — file ops auto-approved, bash scoped to allow list (recommended)", value: "autonomous" },
        { name: "yolo        — all permissions bypassed (use in isolated environments only)", value: "yolo" },
      ],
    },
  ]);
  (config as any).engine.permissionMode = mode;

  if (mode === "autonomous") {
    console.log(`\n    ${chalk.dim("Default allow list: Read, Edit, Write, npm, git, node, python, etc.")}`);
    console.log(`    ${chalk.dim("Default deny list:  rm -rf, sudo, curl, wget, .env, secrets/")}`);
    console.log(`    ${chalk.dim("Customize in tasksmith.yaml → engine.permissions.allow / .deny")}`);
  } else if (mode === "yolo") {
    console.log(chalk.red(`\n    ⚠  YOLO mode bypasses ALL Claude Code permission checks.`));
    console.log(chalk.red(`       Only use in Docker containers, VMs, or disposable environments.`));
  }

  const currentConcurrency = config.engine?.concurrency || 1;
  const { concurrency } = await inquirer.prompt([
    { name: "concurrency", message: "Parallel task slots:", type: "number", default: currentConcurrency },
  ]);
  (config as any).engine.concurrency = concurrency || 1;

  console.log(`    ${chalk.green("✓")} Engine: ${mode}, concurrency=${concurrency || 1}`);
  return config;
}

async function stepSmokeTest(ws: string, config: TaskSmithConfig) {
  step(9, 9, "Smoke Test");

  const enabled = config.communication.outbound.filter(e => e.enabled);
  if (enabled.length) {
    const { sendTest } = await inquirer.prompt([
      { name: "sendTest", message: "Send test notification?", type: "confirm", default: true },
    ]);
    if (sendTest) {
      for (const entry of enabled) {
        if (entry.provider in OUTBOUND_REGISTRY) {
          const Cls = OUTBOUND_REGISTRY[entry.provider];
          const p = new Cls(entry.config);
          const ok = await p.test();
          console.log(`    ${ok ? chalk.green("✓") : chalk.red("✗")} ${entry.provider}`);
        }
      }
    }
  }

  console.log(`\n    ${chalk.green("✓")} Setup complete!`);
}

// =============================================================================
// MAIN
// =============================================================================

export async function runSetup(ws: string, config: TaskSmithConfig, stepName?: string) {
  header("TaskSmith Onboarding");

  // Backup existing config before making changes
  const backup = backupConfig(ws);
  if (backup) console.log(`  ${chalk.dim(`Config backed up → ${backup}`)}`);

  if (!config || !config.communication) config = structuredClone(DEFAULT_CONFIG);

  const steps: Record<string, () => Promise<any>> = {
    prereqs: () => stepPrereqs(),
    dirs: () => stepInit(ws),
    soul: () => stepSoul(ws),
    user: () => stepUser(ws),
    comms: () => stepComms(ws, config),
    models: () => stepModels(ws, config),
    memory: () => stepMemory(ws, config),
    engine: () => stepEngine(ws, config),
    test: () => stepSmokeTest(ws, config),
  };

  if (stepName && stepName in steps) {
    const result = await steps[stepName]();
    if (result?.communication) config = result;
  } else {
    const ok = await stepPrereqs();
    if (!ok) {
      const { cont } = await inquirer.prompt([{ name: "cont", message: "Continue anyway?", type: "confirm", default: false }]);
      if (!cont) return;
    }
    await stepInit(ws);
    await stepSoul(ws);
    await stepUser(ws);
    config = await stepComms(ws, config);
    config = await stepModels(ws, config);
    config = await stepMemory(ws, config);
    config = await stepEngine(ws, config);
    await stepSmokeTest(ws, config);
  }

  saveConfig(ws, config);

  console.log(`
  ${chalk.green.bold("Ready to go!")}

    Start engine:   ${chalk.bold("tasksmith run")}
    Submit task:    ${chalk.bold("tasksmith submit")}
    Check status:   ${chalk.bold("tasksmith status")}

    Re-run a step:  ${chalk.bold("tasksmith setup --step NAME")}
    Steps: prereqs, dirs, soul, user, comms, models, memory, engine, test
`);

  console.log(chalk.yellow.bold("  ⚠  Security Notice\n"));
  console.log(chalk.yellow("  TaskSmith executes AI-generated code on your machine."));
  console.log(chalk.yellow("  This is powerful — and carries real risks.\n"));
  console.log(`  ${chalk.dim("•")} Start with supervised mode until you're comfortable`);
  console.log(`  ${chalk.dim("•")} Use autonomous mode with a restrictive allow list for unattended runs`);
  console.log(`  ${chalk.dim("•")} Only use yolo mode in isolated environments (Docker, VM)`);
  console.log(`  ${chalk.dim("•")} Never expose the REST API to the internet without auth`);
  console.log(`  ${chalk.dim("•")} Restrict Discord bot to private channels with trusted users`);
  console.log(`  ${chalk.dim("•")} Use Docker isolation for untrusted or high-risk tasks`);
  console.log(`  ${chalk.dim("•")} validation_command runs as a shell command — treat it accordingly`);
  console.log(`  ${chalk.dim("•")} Review task files from external sources before dropping in inbox\n`);
  console.log(`  ${chalk.dim("See README.md Security and Permission Modes sections for details.\n")}`);
}
