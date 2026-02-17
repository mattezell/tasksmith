/**
 * TaskSmith Onboarding Wizard
 *
 * Interactive setup. Each step re-runnable: `tasksmith setup --step comms`
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { scaffoldWorkspace, saveConfig, DEFAULT_CONFIG } from "./config.js";
import { OUTBOUND_REGISTRY } from "./providers/comms/providers.js";
import type { ForgeConfig, Notification, Priority } from "./types.js";

function header(text: string) {
  console.log(chalk.blue(`\n  ═══ ${text} ═══\n`));
}

function step(n: number, total: number, text: string) {
  console.log(`\n  ${chalk.cyan(`[${n}/${total}]`)} ${chalk.bold(text)}`);
  console.log(chalk.dim("  " + "─".repeat(48)));
}

// =============================================================================
// STEPS
// =============================================================================

async function stepPrereqs(): Promise<boolean> {
  step(1, 8, "Prerequisites Check");
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
  step(2, 8, "Initialize Workspace");
  scaffoldWorkspace(ws);
  console.log(`    ${chalk.green("✓")} Workspace at ${ws}`);
}

async function stepSoul(ws: string) {
  step(3, 8, "SOUL.md — How Claude Works For You");

  const answers = await inquirer.prompt([
    { name: "style", message: "Communication style:", type: "list", choices: ["concise", "balanced", "verbose"], default: "concise" },
    { name: "philosophy", message: "Code philosophy:", type: "list", choices: ["pragmatic", "principled", "move-fast"], default: "pragmatic" },
    { name: "testsFirst", message: "Test-first approach?", type: "confirm", default: true },
    { name: "minComments", message: "Minimal comments (self-documenting code)?", type: "confirm", default: true },
    { name: "uncertain", message: "When uncertain:", type: "list", choices: ["ask first", "try then check"], default: "try then check" },
    { name: "anti", message: "Anti-patterns (comma-separated):", default: "over-engineering, unnecessary abstractions, premature optimization" },
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
  step(4, 8, "USER.md — About You");

  const answers = await inquirer.prompt([
    { name: "name", message: "Name/handle:", default: "" },
    { name: "role", message: "Role:", default: "software architect" },
    { name: "langs", message: "Primary languages:", default: "TypeScript, Python, Go" },
    { name: "gpu", message: "GPU for local inference (or 'none'):", default: "none" },
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

async function stepComms(ws: string, config: ForgeConfig): Promise<ForgeConfig> {
  step(5, 8, "Communication");

  const { outbound } = await inquirer.prompt([{
    name: "outbound",
    message: "Outbound notifications (select all that apply):",
    type: "checkbox",
    choices: [
      { name: "Discord Webhook", value: "discord_webhook" },
      { name: "ntfy.sh push notifications", value: "ntfy" },
      { name: "Slack Webhook", value: "slack_webhook" },
      { name: "Email (SMTP)", value: "email" },
      { name: "Generic Webhook", value: "webhook_generic" },
    ],
  }]);

  // Disable all first
  for (const e of config.communication.outbound) e.enabled = false;

  for (const provider of outbound) {
    const entry = config.communication.outbound.find(e => e.provider === provider);
    if (!entry) continue;
    entry.enabled = true;

    if (provider === "discord_webhook") {
      const { url } = await inquirer.prompt([{ name: "url", message: "Discord webhook URL:" }]);
      entry.config.webhookUrl = url;
    } else if (provider === "ntfy") {
      const a = await inquirer.prompt([
        { name: "topic", message: "ntfy topic:", default: "tasksmith" },
        { name: "server", message: "ntfy server:", default: "https://ntfy.sh" },
      ]);
      entry.config.topic = a.topic;
      entry.config.server = a.server;
    } else if (provider === "slack_webhook") {
      const { url } = await inquirer.prompt([{ name: "url", message: "Slack webhook URL:" }]);
      entry.config.webhookUrl = url;
    }
  }

  // Inbound
  console.log(`\n    File drop is always enabled (YAML in tasks/inbox/)`);

  const { enableDiscord } = await inquirer.prompt([
    { name: "enableDiscord", message: "Enable Discord bot (bidirectional)?", type: "confirm", default: false },
  ]);
  if (enableDiscord) {
    const a = await inquirer.prompt([
      { name: "token", message: "Bot token:" },
      { name: "channel", message: "Channel ID (or empty for all):", default: "" },
    ]);
    const entry = config.communication.inbound.find(e => e.provider === "discord_bot")!;
    entry.enabled = true;
    entry.config.botToken = a.token;
    entry.config.channelId = a.channel;
  }

  const { enableApi } = await inquirer.prompt([
    { name: "enableApi", message: "Enable REST API (port 8420)?", type: "confirm", default: true },
  ]);
  config.communication.inbound.find(e => e.provider === "rest_api")!.enabled = enableApi;

  console.log(`    ${chalk.green("✓")} Communication configured`);
  return config;
}

async function stepModels(ws: string, config: ForgeConfig): Promise<ForgeConfig> {
  step(6, 8, "Model Routing");

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

    const { useLocal } = await inquirer.prompt([
      { name: "useLocal", message: "Use local models for summarization & embeddings?", type: "confirm", default: true },
    ]);
    if (useLocal) {
      const a = await inquirer.prompt([
        { name: "embed", message: "Embedding model:", default: "nomic-embed-text" },
        { name: "summarize", message: "Summarize model:", default: "qwen3:14b" },
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

async function stepMemory(ws: string, config: ForgeConfig): Promise<ForgeConfig> {
  step(7, 8, "Memory System");
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

async function stepSmokeTest(ws: string, config: ForgeConfig) {
  step(8, 8, "Smoke Test");

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

export async function runSetup(ws: string, config: ForgeConfig, stepName?: string) {
  header("TaskSmith Onboarding");

  if (!config || !config.communication) config = structuredClone(DEFAULT_CONFIG);

  const steps: Record<string, () => Promise<any>> = {
    prereqs: () => stepPrereqs(),
    dirs: () => stepInit(ws),
    soul: () => stepSoul(ws),
    user: () => stepUser(ws),
    comms: () => stepComms(ws, config),
    models: () => stepModels(ws, config),
    memory: () => stepMemory(ws, config),
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
    await stepSmokeTest(ws, config);
  }

  saveConfig(ws, config);

  console.log(`
  ${chalk.green.bold("Ready to go!")}

    Start engine:   ${chalk.bold("tasksmith run")}
    Submit task:    ${chalk.bold("tasksmith submit")}
    Check status:   ${chalk.bold("tasksmith status")}

    Re-run a step:  ${chalk.bold("tasksmith setup --step NAME")}
    Steps: prereqs, dirs, soul, user, comms, models, memory, test
`);
}
