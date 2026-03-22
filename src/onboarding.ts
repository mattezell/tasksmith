/**
 * TaskSmith Onboarding — Simplified Setup
 *
 * `tasksmith setup` detects Claude Code, scaffolds workspace, configures
 * communication, and verifies connectivity. Steps are individually re-runnable
 * via `tasksmith setup --step <name>`.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { execSync } from "node:child_process";
import { scaffoldWorkspace, saveConfig, backupConfig, installBundledSkills, DEFAULT_CONFIG } from "./config.js";
import { OUTBOUND_REGISTRY } from "./providers/comms/providers.js";
import type { TaskSmithConfig } from "./types.js";

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
  step(1, 4, "Prerequisites Check");
  const checks: [string, string][] = [
    ["Claude Code CLI", "claude --version"],
    ["Node.js 18+", "node --version"],
    ["git", "git --version"],
  ];

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

  // Optional tools
  const optional: [string, string][] = [
    ["gh CLI", "gh --version"],
    ["Ollama", "ollama --version"],
  ];
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

async function stepInit(workspace: string) {
  step(2, 4, "Initialize Workspace");
  scaffoldWorkspace(workspace);
  installBundledSkills(workspace);
  console.log(`    ${chalk.green("✓")} Workspace at ${workspace}`);
}

async function stepComms(_ws: string, config: TaskSmithConfig): Promise<TaskSmithConfig> {
  step(3, 4, "Communication");

  // Engine config
  const engineCfg = (config as any).engine || {};
  const currentMode = engineCfg.permissionMode || "supervised";
  const currentConcurrency = engineCfg.concurrency || 1;

  const { mode, concurrency } = await inquirer.prompt([
    {
      name: "mode",
      message: "Permission mode:",
      type: "list",
      default: currentMode,
      choices: [
        { name: "supervised  — tasks may stall on permission prompts (safest)", value: "supervised" },
        { name: "autonomous  — file ops auto-approved (recommended for unattended)", value: "autonomous" },
        { name: "yolo        — all permissions bypassed (isolated environments only)", value: "yolo" },
      ],
    },
    { name: "concurrency", message: "Parallel task slots:", type: "number", default: currentConcurrency },
  ]);

  if (!config.engine) (config as any).engine = {};
  (config as any).engine.permissionMode = mode;
  (config as any).engine.concurrency = concurrency || 1;

  if (mode === "yolo") {
    console.log(chalk.red(`\n    ⚠  YOLO mode bypasses ALL Claude Code permission checks.`));
    console.log(chalk.red(`       Only use in Docker containers, VMs, or disposable environments.`));
  }

  // Outbound notifications
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
  restApi.enabled = enableApi;

  console.log(`    ${chalk.green("✓")} Communication configured`);
  return config;
}

async function stepSmokeTest(_ws: string, config: TaskSmithConfig) {
  step(4, 4, "Smoke Test");

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
  header("TaskSmith Setup");

  // Backup existing config before making changes
  const backup = backupConfig(ws);
  if (backup) console.log(`  ${chalk.dim(`Config backed up → ${backup}`)}`);

  if (!config || !config.communication) config = structuredClone(DEFAULT_CONFIG);

  const steps: Record<string, () => Promise<any>> = {
    prereqs: () => stepPrereqs(),
    dirs: () => stepInit(ws),
    comms: () => stepComms(ws, config),
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
    config = await stepComms(ws, config);
    await stepSmokeTest(ws, config);
  }

  saveConfig(ws, config);

  console.log(`
  ${chalk.green.bold("Ready to go!")}

    Start engine:   ${chalk.bold("tasksmith run")}
    Submit task:    ${chalk.bold("tasksmith submit")}
    Check status:   ${chalk.bold("tasksmith status")}

    Re-run a step:  ${chalk.bold("tasksmith setup --step NAME")}
    Steps: prereqs, dirs, comms, test
`);

  console.log(chalk.yellow.bold("  ⚠  Security Notice\n"));
  console.log(chalk.yellow("  TaskSmith executes AI-generated code on your machine."));
  console.log(chalk.yellow("  This is powerful — and carries real risks.\n"));
  console.log(`  ${chalk.dim("•")} Start with supervised mode until you're comfortable`);
  console.log(`  ${chalk.dim("•")} Use autonomous mode for unattended runs`);
  console.log(`  ${chalk.dim("•")} Only use yolo mode in isolated environments (Docker, VM)`);
  console.log(`  ${chalk.dim("•")} Never expose the REST API to the internet without auth`);
  console.log(`  ${chalk.dim("•")} Restrict Discord bot to private channels with trusted users`);
  console.log(`  ${chalk.dim("•")} validation_command runs as a shell command — treat it accordingly`);
  console.log(`  ${chalk.dim("•")} Review task files from external sources before dropping in inbox\n`);
}
