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
 * Template resolution order:
 *   1. Project-local: ./.tasksmith/templates/<n>/PROMPT.md
 *   2. Workspace: <workspace>/templates/<n>/PROMPT.md
 *   3. Global override: ~/.tasksmith/templates/<n>/PROMPT.md
 *   4. Built-in: <install-dir>/templates/<n>/PROMPT.md
 *   5. Plugin-provided templates
 * 
 * Config layering:
 *   defaults -> global ~/.tasksmith config -> workspace config -> env overrides
 * 
 * File formats: YAML (.yaml/.yml) and JSON (.json) for both config and task files.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { ForgeConfig } from "./types.js";

// =============================================================================
// DEFAULT CONFIG
// =============================================================================

export const DEFAULT_CONFIG: ForgeConfig = {
  system: { name: "TaskSmith", version: "0.5.0", logLevel: "INFO" },
  workspace: {
    projectsDir: "",        // if empty, defaults to <workspace>/projects
    templatesDir: "",       // additional template search path
    globalConfigDir: "",    // if empty, defaults to ~/.tasksmith
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
// WORKSPACE RESOLUTION
// =============================================================================

const WORKSPACE_DIRS = [
  "config", "directives",
  "tasks/inbox", "tasks/active", "tasks/completed", "tasks/failed", "tasks/examples",
  "projects", "memory/sessions", "memory/logs",
  "comms/outbox", "comms/inbox",
  "output", "scripts", "templates",
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
export function resolveProjectsDir(workspace: string, config: ForgeConfig): string {
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
  for (const d of ["config", "templates", "tasks/inbox", "tasks/active", "tasks/completed", "tasks/failed", "directives"]) {
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
// TEMPLATE RESOLUTION
// =============================================================================

/**
 * Resolve template directory by searching paths in priority order.
 * Returns path to directory containing PROMPT.md, or null.
 */
export function resolveTemplate(templateName: string, workspace: string, config: ForgeConfig): string | null {
  const normalized = templateName.replace(/-/g, "_");
  const searchPaths: string[] = [];

  // 1. Project-local (.tasksmith/templates/)
  const cwd = process.cwd();
  const dotTs = join(cwd, ".tasksmith", "templates");
  if (existsSync(dotTs)) {
    searchPaths.push(join(dotTs, normalized));
    if (normalized !== templateName) searchPaths.push(join(dotTs, templateName));
  }

  // 2. Workspace templates/
  searchPaths.push(join(workspace, "templates", normalized));
  if (normalized !== templateName) searchPaths.push(join(workspace, "templates", templateName));

  // 3. Extra templates dir from config
  if (config.workspace?.templatesDir) {
    const extra = resolve(config.workspace.templatesDir);
    searchPaths.push(join(extra, normalized));
  }

  // 4. Global override (~/.tasksmith/templates/) if workspace != global
  const global = globalConfigDir();
  if (resolve(workspace) !== resolve(global)) {
    searchPaths.push(join(global, "templates", normalized));
  }

  // 5. Built-in (shipped with npm package)
  const builtinBase = join(import.meta.dirname ?? dirname(new URL(import.meta.url).pathname), "..", "templates");
  searchPaths.push(join(builtinBase, normalized));
  if (normalized !== templateName) searchPaths.push(join(builtinBase, templateName));

  for (const dir of searchPaths) {
    if (existsSync(join(dir, "PROMPT.md"))) return dir;
  }
  return null;
}

/**
 * List all available templates across all search paths (deduplicated, first wins).
 */
export function listTemplates(workspace: string, config: ForgeConfig): Array<{ name: string; source: string; path: string }> {
  const found = new Map<string, { source: string; path: string }>();

  const scan = (dir: string, source: string) => {
    if (!existsSync(dir)) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(dir, entry.name, "PROMPT.md"))) {
          if (!found.has(entry.name)) found.set(entry.name, { source, path: join(dir, entry.name) });
        }
      }
    } catch { /* permission errors, etc */ }
  };

  const cwd = process.cwd();
  if (existsSync(join(cwd, ".tasksmith", "templates"))) scan(join(cwd, ".tasksmith", "templates"), "project-local");
  scan(join(workspace, "templates"), "workspace");
  if (config.workspace?.templatesDir) scan(resolve(config.workspace.templatesDir), "custom");
  const global = globalConfigDir();
  if (resolve(workspace) !== resolve(global)) scan(join(global, "templates"), "global");
  const builtinBase = join(import.meta.dirname ?? dirname(new URL(import.meta.url).pathname), "..", "templates");
  scan(builtinBase, "built-in");

  return Array.from(found.entries()).map(([name, info]) => ({ name, ...info }));
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
export function loadConfig(workspace: string): ForgeConfig {
  let config = structuredClone(DEFAULT_CONFIG);

  // Layer 1: Global config (if workspace is not already global)
  const global = globalConfigDir();
  if (resolve(workspace) !== resolve(global)) {
    const globalFile = findConfigFile(global);
    if (globalFile) {
      const raw = readFileSync(globalFile, "utf-8");
      config = deepMerge(config, parseConfigFile(raw, globalFile)) as ForgeConfig;
    }
  }

  // Layer 2: Workspace config
  const wsFile = findConfigFile(workspace);
  if (wsFile) {
    const raw = readFileSync(wsFile, "utf-8");
    config = deepMerge(config, parseConfigFile(raw, wsFile)) as ForgeConfig;
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

export function saveConfig(workspace: string, config: ForgeConfig, format: "yaml" | "json" = "yaml"): string {
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
