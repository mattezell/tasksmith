/**
 * Configuration management.
 * Handles loading, merging, defaults, and workspace scaffolding.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { ForgeConfig } from "./types.js";

// =============================================================================
// DEFAULT CONFIG
// =============================================================================

export const DEFAULT_CONFIG: ForgeConfig = {
  system: { name: "TaskSmith", version: "0.3.0", logLevel: "INFO" },
  communication: {
    outbound: [
      { provider: "discord_webhook", enabled: false, config: { webhookUrl: "", username: "TaskSmith" } },
      { provider: "ntfy", enabled: false, config: { topic: "tasksmith", server: "https://ntfy.sh", priority: "default" } },
      { provider: "slack_webhook", enabled: false, config: { webhookUrl: "" } },
      { provider: "email", enabled: false, config: { smtpHost: "", smtpPort: 587, smtpUser: "", smtpPass: "", fromAddr: "", toAddr: "" } },
      { provider: "sms_twilio", enabled: false, config: { accountSid: "", authToken: "", fromNumber: "", toNumber: "" } },
      { provider: "webhook_generic", enabled: false, config: { url: "", method: "POST", headers: {} } },
    ],
    inbound: [
      { provider: "file_drop", enabled: true, config: {} },
      { provider: "discord_bot", enabled: false, config: { botToken: "", channelId: "", commandPrefix: "@forge" } },
      { provider: "rest_api", enabled: false, config: { host: "0.0.0.0", port: 8420 } },
      { provider: "watched_folder", enabled: false, config: { path: "" } },
    ],
  },
  memory: {
    hot: { provider: "markdown", config: { memoryFile: "directives/MEMORY.md", dailyLogDir: "memory", maxHotTokens: 2000, loadDays: 2 } },
    warm: [
      { provider: "jsonl_logs", enabled: true, config: { logDir: "memory/logs" } },
      { provider: "mem0", enabled: false, config: { serverUrl: "http://localhost:8080", searchType: "hybrid" } },
    ],
    cold: { provider: "compressed_json", config: { archiveDir: "memory/sessions", compress: true } },
  },
  models: {
    routing: {
      complex_code: { provider: "claude_code", model: "opus" },
      standard_tasks: { provider: "claude_code", model: "sonnet" },
      research: { provider: "claude_code", model: "sonnet" },
      memory_summarize: { provider: "ollama", model: "qwen3:14b", fallback: { provider: "claude_code", model: "sonnet" } },
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
      classification: { provider: "ollama", model: "llama3.2:8b", fallback: { provider: "claude_code", model: "sonnet" } },
      evaluation: { provider: "ollama", model: "qwen3:14b", fallback: { provider: "claude_code", model: "sonnet" } },
    },
    providers: [
      { provider: "claude_code", enabled: true, config: { defaultAllowedTools: ["Write", "Read", "Edit", "Bash", "Task"], outputFormat: "json" } },
      { provider: "ollama", enabled: false, config: { baseUrl: "http://localhost:11434" } },
      { provider: "lmstudio", enabled: false, config: { baseUrl: "http://localhost:1234/v1" } },
    ],
  },
  fileSharing: [
    { provider: "syncthing", enabled: false, config: { outputDir: "" } },
    { provider: "rclone", enabled: false, config: { remote: "", outputDir: "" } },
    { provider: "local_only", enabled: true, config: { outputDir: "output" } },
  ],
  scheduling: {
    provider: "cron",
    tasks: [
      { name: "memory_consolidation", schedule: "0 3 * * *", template: "heartbeat", params: { type: "memory_consolidation" }, enabled: true },
      { name: "daily_briefing", schedule: "0 8 * * *", template: "heartbeat", params: { type: "daily_briefing" }, enabled: false },
      { name: "health_check", schedule: "0 * * * *", template: "heartbeat", params: { type: "health_check" }, enabled: true },
    ],
  },
  taskDefaults: {
    maxIterations: 5,
    timeoutMinutes: 30,
    notifyOnComplete: true,
    notifyOnFailure: true,
    model: "sonnet",
    priority: "normal",
  },
};

// =============================================================================
// WORKSPACE
// =============================================================================

const WORKSPACE_DIRS = [
  "config", "directives",
  "tasks/inbox", "tasks/active", "tasks/completed", "tasks/failed", "tasks/examples",
  "projects", "memory/sessions", "memory/logs",
  "comms/outbox", "comms/inbox",
  "output", "scripts",
];

export function resolveWorkspace(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const env = process.env.TASKSMITH_DIR;
  if (env) return resolve(env);
  const cwd = process.cwd();
  if (existsSync(join(cwd, "config", "tasksmith.yaml"))) return cwd;
  return join(homedir(), ".tasksmith");
}

export function scaffoldWorkspace(workspace: string): void {
  for (const dir of WORKSPACE_DIRS) {
    mkdirSync(join(workspace, dir), { recursive: true });
  }
}

export function loadConfig(workspace: string): ForgeConfig {
  const configFile = join(workspace, "config", "tasksmith.yaml");
  if (existsSync(configFile)) {
    const raw = readFileSync(configFile, "utf-8");
    const userConfig = yaml.load(raw) as Partial<ForgeConfig>;
    return deepMerge(structuredClone(DEFAULT_CONFIG), userConfig ?? {}) as ForgeConfig;
  }
  return structuredClone(DEFAULT_CONFIG);
}

export function saveConfig(workspace: string, config: ForgeConfig): string {
  const configFile = join(workspace, "config", "tasksmith.yaml");
  mkdirSync(join(workspace, "config"), { recursive: true });
  writeFileSync(configFile, yaml.dump(config, { lineWidth: 120, noRefs: true }));
  return configFile;
}

function deepMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key in result && typeof result[key] === "object" && !Array.isArray(result[key]) && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
