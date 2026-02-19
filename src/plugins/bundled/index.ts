/**
 * TaskSmith Bundled Plugin Registry
 *
 * Official plugins that ship with tasksmith-cli.
 * Users enable them in config — no separate npm install needed.
 *
 * Config:
 *   plugins:
 *     - github
 *     - metrics
 *     - docker
 *     - jira
 *     - postgres
 *     - proxmox
 *     - sandbox
 *
 * Bundled plugins load BEFORE npm-discovered plugins,
 * so they can be overridden by installing an npm package with the same name.
 */

import type { PluginActivateFn } from "../../plugins.js";

// Lazy imports — unused plugins add zero startup cost
const BUNDLED_PLUGINS: Record<string, () => Promise<{ default: PluginActivateFn }>> = {
  github:     () => import("./github.js"),
  metrics:    () => import("./metrics.js"),
  docker:     () => import("./docker.js"),
  jira:       () => import("./jira.js"),
  postgres:   () => import("./postgres.js"),
  proxmox:    () => import("./proxmox.js"),
  cloudflare: () => import("./cloudflare.js"),
  "semantic-memory": () => import("./semantic-memory.js"),
  sandbox:    () => import("./sandbox.js"),
};

/** List of all bundled plugin names */
export function listBundledPlugins(): string[] {
  return Object.keys(BUNDLED_PLUGINS);
}

/** Check if a plugin name is a bundled official plugin */
export function isBundledPlugin(name: string): boolean {
  return name in BUNDLED_PLUGINS;
}

/** Load a bundled plugin's activate function */
export async function loadBundledPlugin(name: string): Promise<PluginActivateFn | null> {
  const loader = BUNDLED_PLUGINS[name];
  if (!loader) return null;
  const mod = await loader();
  return mod.default;
}

/** Metadata about bundled plugins for display */
export const BUNDLED_PLUGIN_INFO: Record<string, { description: string; configKeys: string[] }> = {
  github: {
    description: "GitHub Issues/PR integration — auto-create issues on failure, close on success",
    configKeys: ["token", "owner", "repo", "createIssuesOnFailure", "closeIssuesOnSuccess", "labels"],
  },
  metrics: {
    description: "Task execution metrics — success rates, timing, model/template breakdown",
    configKeys: ["metricsFile", "retainDays", "trackModels", "trackTemplates"],
  },
  docker: {
    description: "Docker container isolation — run tasks in sandboxed containers",
    configKeys: ["image", "mountProject", "resourceLimits", "networkMode", "autoCleanup"],
  },
  jira: {
    description: "JIRA ticket integration — create tickets on failure, transition on success",
    configKeys: ["host", "email", "apiToken", "projectKey", "issueType"],
  },
  postgres: {
    description: "PostgreSQL task history — queryable execution records and analytics",
    configKeys: ["connectionString", "tableName", "autoMigrate"],
  },
  proxmox: {
    description: "Proxmox VM provisioning — full OS-level isolation for task execution",
    configKeys: ["host", "tokenId", "tokenSecret", "node", "templateVmId"],
  },
  cloudflare: {
    description: "Cloudflare Pages deployments — auto-deploy, rollback, cache purge",
    configKeys: ["accountId", "apiToken", "pages.projectName", "pages.deployDir", "purgeCache"],
  },
  "semantic-memory": {
    description: "Vector-based semantic memory search via local Ollama embeddings",
    configKeys: ["ollamaUrl", "model", "embeddingsFile", "maxResults", "minSimilarity"],
  },
  sandbox: {
    description: "OS-level process isolation via @anthropic-ai/sandbox-runtime — filesystem + network boundaries without Docker",
    configKeys: ["enabled", "allowedDomains", "deniedDomains", "allowWrite", "denyRead", "denyWrite", "allowUnsandboxedCommands", "logViolations"],
  },
};
