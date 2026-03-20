/**
 * TaskSmith Configuration
 *
 * Handles loading, merging, defaults, workspace scaffolding, and path resolution.
 *
 * Workspace resolution order:
 *   1. --dir CLI flag (explicit workspace)
 *   2. TASKSMITH_DIR env var
 *   3. Project-local: cwd (or parent) has .tasksmith/ or tasksmith.yaml
 *   4. Global: ~/.tasksmith
 *
 * Config layering:
 *   defaults -> global ~/.tasksmith config -> workspace config -> env overrides
 *
 * File formats: YAML (.yaml/.yml) and JSON (.json) for both config and task files.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { TaskSmithConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

// =============================================================================
// DEFAULT CONFIG
// =============================================================================

export const DEFAULT_CONFIG: TaskSmithConfig = {
  system: { name: "TaskSmith", version: pkg.version, logLevel: "INFO" },
  workspace: {
    projectsDir: "",        // if empty, defaults to <workspace>/projects
    globalConfigDir: "",    // if empty, defaults to ~/.tasksmith
  },
  engine: {
    concurrency: 1,
    permissionMode: "supervised",
  },
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
      { provider: "discord_bot", enabled: false, config: { botToken: "", channelId: "", commandPrefix: "@tasksmith" } },
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
    circuitBreaker: {
      enabled: true,
      maxConsecutiveInfra: 2,
      maxConsecutiveContradictions: 3,
      maxConsecutiveIdenticalFailures: 3,
      maxConsecutiveTimeouts: 2,
      costCeilingUsd: 0,
    },
  },
};

// =============================================================================
// WORKSPACE RESOLUTION
// =============================================================================

const WORKSPACE_DIRS = [
  "config", "directives",
  "tasks/inbox", "tasks/active", "tasks/completed", "tasks/failed", "tasks/examples",
  "projects", "memory/sessions", "memory/logs",
  "comms/outbox", "comms/inbox",
  "output", "scripts",
];

/** Global config directory — always ~/.tasksmith */
export function globalConfigDir(): string {
  return join(homedir(), ".tasksmith");
}

/** Find the config file in a workspace directory. Checks yaml, yml, json. */
function findConfigFile(workspace: string): string | null {
  const candidates = [
    join(workspace, "config", "tasksmith.yaml"),
    join(workspace, "config", "tasksmith.yml"),
    join(workspace, "config", "tasksmith.json"),
    join(workspace, "tasksmith.yaml"),
    join(workspace, "tasksmith.yml"),
    join(workspace, "tasksmith.json"),
  ];
  for (const f of candidates) {
    if (existsSync(f)) return f;
  }
  return null;
}

/**
 * Detect if a directory (or ancestor) has TaskSmith project-local config.
 * Walks up from startDir looking for .tasksmith/ dir, tasksmith.yaml, or config/ dir.
 */
function detectProjectConfig(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = dirname(dir);

  for (let i = 0; i < 10 && dir !== root; i++) {
    // .tasksmith/ subdirectory (project-local mode)
    const dotDir = join(dir, ".tasksmith");
    if (findConfigFile(dotDir)) return dotDir;

    // tasksmith.yaml in project root (simple mode)
    for (const ext of ["yaml", "yml", "json"]) {
      if (existsSync(join(dir, `tasksmith.${ext}`))) return dir;
    }

    // config/ subdirectory
    if (findConfigFile(dir)) return dir;

    dir = dirname(dir);
  }
  return null;
}

/**
 * Resolve the workspace directory.
 * Priority: explicit --dir > TASKSMITH_DIR env > project-local > ~/.tasksmith
 */
export function resolveWorkspace(explicit?: string): string {
  if (explicit) return resolve(explicit);

  const env = process.env.TASKSMITH_DIR;
  if (env) return resolve(env);

  const projectWs = detectProjectConfig(process.cwd());
  if (projectWs) return projectWs;

  return globalConfigDir();
}

/**
 * Resolve where projects live.
 * Uses workspace.projectsDir from config, or <workspace>/projects.
 */
export function resolveProjectsDir(workspace: string, config: TaskSmithConfig): string {
  if (config.workspace?.projectsDir) return resolve(config.workspace.projectsDir);
  return join(workspace, "projects");
}

/** Workspace info for display/debugging. */
export function workspaceInfo(workspace: string): { mode: string; path: string; projectsDir: string } {
  const global = globalConfigDir();
  const isGlobal = resolve(workspace) === resolve(global);
  const config = loadConfig(workspace);
  return {
    mode: isGlobal ? "global" : workspace.endsWith(".tasksmith") ? "project-local" : "custom",
    path: workspace,
    projectsDir: resolveProjectsDir(workspace, config),
  };
}

export function scaffoldWorkspace(workspace: string): void {
  for (const dir of WORKSPACE_DIRS) {
    mkdirSync(join(workspace, dir), { recursive: true });
  }
}

/**
 * Initialize project-local TaskSmith config in the current directory.
 * Creates .tasksmith/ with minimal structure that inherits from global.
 */
export function initProjectLocal(projectDir: string): string {
  const tsDir = join(projectDir, ".tasksmith");
  for (const d of ["config", "tasks/inbox", "tasks/active", "tasks/completed", "tasks/failed", "directives"]) {
    mkdirSync(join(tsDir, d), { recursive: true });
  }

  const configFile = join(tsDir, "config", "tasksmith.yaml");
  if (!existsSync(configFile)) {
    const projectConfig = {
      workspace: { projectsDir: projectDir },
      taskDefaults: { model: "sonnet" },
    };
    writeFileSync(configFile, yaml.dump(projectConfig, { lineWidth: 120, noRefs: true }));
  }

  return tsDir;
}

// =============================================================================
// CONFIG LOADING (YAML + JSON)
// =============================================================================

/** Parse a config/task file — supports YAML and JSON based on extension. */
export function parseConfigFile(content: string, filePath: string): Record<string, any> {
  if (filePath.endsWith(".json")) return JSON.parse(content);
  return (yaml.load(content) as Record<string, any>) ?? {};
}

/**
 * Load config with layered merge:
 *   defaults -> global config -> workspace config
 */
export function loadConfig(workspace: string): TaskSmithConfig {
  let config = structuredClone(DEFAULT_CONFIG);

  // Layer 1: Global config (if workspace is not already global)
  const global = globalConfigDir();
  if (resolve(workspace) !== resolve(global)) {
    const globalFile = findConfigFile(global);
    if (globalFile) {
      const raw = readFileSync(globalFile, "utf-8");
      config = deepMerge(config, parseConfigFile(raw, globalFile)) as TaskSmithConfig;
    }
  }

  // Layer 2: Workspace config
  const wsFile = findConfigFile(workspace);
  if (wsFile) {
    const raw = readFileSync(wsFile, "utf-8");
    config = deepMerge(config, parseConfigFile(raw, wsFile)) as TaskSmithConfig;
  }

  return config;
}

/** Create a timestamped backup of the existing config file. Returns backup path or null if no config exists. */
export function backupConfig(workspace: string): string | null {
  const configFile = findConfigFile(workspace);
  if (!configFile) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = `${configFile}.${timestamp}.bak`;
  copyFileSync(configFile, backupFile);
  return backupFile;
}

export function saveConfig(workspace: string, config: TaskSmithConfig, format: "yaml" | "json" = "yaml"): string {
  const ext = format === "json" ? "json" : "yaml";
  const configFile = join(workspace, "config", `tasksmith.${ext}`);
  mkdirSync(join(workspace, "config"), { recursive: true });
  if (format === "json") {
    writeFileSync(configFile, JSON.stringify(config, null, 2));
  } else {
    writeFileSync(configFile, yaml.dump(config, { lineWidth: 120, noRefs: true }));
  }
  return configFile;
}

// =============================================================================
// TASK FILE SUPPORT (YAML + JSON)
// =============================================================================

/** Check if a filename is a supported task file. */
export function isTaskFile(filename: string): boolean {
  return /\.(yaml|yml|json)$/.test(filename) && !filename.startsWith(".");
}

/** Parse task file content based on file extension. */
export function parseTaskFile(content: string, filePath: string): Record<string, any> {
  return parseConfigFile(content, filePath);
}

// =============================================================================
// UTILITIES
// =============================================================================

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
