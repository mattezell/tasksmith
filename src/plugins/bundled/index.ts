/**
 * TaskSmith Bundled Plugin Registry
 *
 * Official plugins that ship with tasksmith-cli.
 * Users enable them in config — no separate npm install needed.
 *
 * Config:
 *   plugins:
 *     - github                     # shorthand, uses defaults
 *     - name: metrics              # with custom config
 *       config:
 *         retainDays: 180
 *     - name: docker
 *       config:
 *         image: "node:22-slim"
 *
 * Bundled plugins are loaded BEFORE npm-discovered plugins,
 * so they can be overridden by installing an npm package with the same name.
 */

import type { PluginActivateFn } from "../../plugins.js";

// Plugin name → lazy import function
// We use dynamic imports so unused plugins don't add startup cost
const BUNDLED_PLUGINS: Record<string, () => Promise<{ default: PluginActivateFn }>> = {
  github: () => import("./github.js"),
  metrics: () => import("./metrics.js"),
  docker: () => import("./docker.js"),
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
};
