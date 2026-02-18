/**
 * TaskSmith Plugin System
 *
 * Design informed by: Fastify (register + encapsulation), Vite/Rollup (naming
 * conventions + keyword discovery), VS Code (manifest contributes pattern),
 * and Gatsby (convention-over-config + options pass-through).
 *
 * Principles:
 *   1. npm IS the plugin manager (no custom registry)
 *   2. A plugin is a function that receives the plugin context + options
 *   3. Discovery via package.json keyword "tasksmith-plugin"
 *   4. Manifest via package.json "tasksmith" field (what the plugin provides)
 *   5. Zero-config for simple plugins, full control when needed
 *
 * Plugin authoring (minimum viable plugin):
 *
 *   // tasksmith-plugin-proxmox/index.js
 *   export default function proxmoxPlugin(forge, options) {
 *     forge.addProvider("outbound", new ProxmoxNotifier(options));
 *     forge.addTemplate("proxmox-provision", "./templates/provision");
 *   }
 *
 * Plugin package.json:
 *
 *   {
 *     "name": "tasksmith-plugin-proxmox",
 *     "keywords": ["tasksmith-plugin"],
 *     "tasksmith": {
 *       "provides": {
 *         "providers": ["proxmox_outbound"],
 *         "templates": ["proxmox-provision", "proxmox-snapshot"],
 *       },
 *       "configDefaults": {
 *         "proxmox": { "host": "", "tokenId": "", "tokenSecret": "" }
 *       }
 *     }
 *   }
 *
 * User config (tasksmith.yaml):
 *
 *   plugins:
 *     - name: tasksmith-plugin-proxmox
 *       enabled: true
 *       config:
 *         host: "https://pve.lan:8006"
 *         tokenId: "claude@pve!forge"
 *         tokenSecret: "xxx"
 *
 * Or simply:
 *   plugins:
 *     - tasksmith-plugin-proxmox
 *
 * That's it. npm install, add one line to config, done.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import chalk from "chalk";
import type {
  OutboundCommsProvider, InboundCommsProvider, MemoryProvider,
  InboundCallback, Notification, MemoryEntry, MemorySearchResult,
} from "./types.js";

// =============================================================================
// PLUGIN INTERFACE — What a plugin author implements
// =============================================================================

/**
 * The context object passed to every plugin's activate function.
 * This is the plugin's only way to extend TaskSmith.
 */
export interface PluginContext {
  /** Register an outbound communication provider */
  addOutboundProvider(provider: OutboundCommsProvider): void;

  /** Register an inbound communication provider */
  addInboundProvider(provider: InboundCommsProvider): void;

  /** Register a memory provider */
  addMemoryProvider(provider: MemoryProvider): void;

  /** Register a template (directory containing PROMPT.md + optional files) */
  addTemplate(name: string, templateDir: string): void;

  /** Register a CLI command extension */
  addCommand(name: string, handler: PluginCommandHandler): void;

  /** Register a hook into the task lifecycle */
  addHook(event: PluginHookEvent, handler: PluginHook): void;

  /** Access the workspace directory */
  readonly workspace: string;

  /** Access the full config (read-only) */
  readonly config: Record<string, unknown>;

  /** Log with the plugin's name as prefix */
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

export type PluginActivateFn = (ctx: PluginContext, options: Record<string, unknown>) => void | Promise<void>;
export type PluginDeactivateFn = () => void | Promise<void>;

export type PluginHookEvent =
  | "beforeTaskExecute"   // Before Claude Code invocation
  | "afterTaskExecute"    // After task completes (success or fail)
  | "beforeContextAssembly" // Before prompt is assembled
  | "afterContextAssembly"  // After prompt is assembled (can modify)
  | "onMemoryFlush"       // When memory is being flushed
  | "onInboundMessage"    // When an inbound message arrives (can transform)
  | "onStartup"           // When the engine starts
  | "onShutdown";         // When the engine shuts down

export type PluginHook = (data: Record<string, unknown>) => void | Promise<void> | Record<string, unknown> | Promise<Record<string, unknown>>;

export interface PluginCommandHandler {
  description: string;
  options?: Array<{ flag: string; description: string; default?: string }>;
  action: (args: Record<string, string>) => void | Promise<void>;
}

/**
 * Plugin manifest — declared in package.json under "tasksmith" key.
 * This is optional but enables auto-discovery and config scaffolding.
 */
export interface PluginManifest {
  provides?: {
    providers?: string[];
    templates?: string[];
    commands?: string[];
    hooks?: string[];
  };
  configDefaults?: Record<string, unknown>;
  /** Minimum TaskSmith version required */
  minVersion?: string;
  /** Other plugins this one depends on */
  dependencies?: string[];
}

// =============================================================================
// PLUGIN LOADER — Discovery, validation, and lifecycle
// =============================================================================

interface LoadedPlugin {
  name: string;
  manifest: PluginManifest;
  activate: PluginActivateFn;
  deactivate?: PluginDeactivateFn;
  options: Record<string, unknown>;
}

export class PluginManager {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private hooks: Map<PluginHookEvent, Array<{ pluginName: string; handler: PluginHook }>> = new Map();
  private templates: Map<string, string> = new Map(); // name → dir
  private commands: Map<string, { pluginName: string; handler: PluginCommandHandler }> = new Map();
  private additionalOutbound: OutboundCommsProvider[] = [];
  private additionalInbound: InboundCommsProvider[] = [];
  private additionalMemory: MemoryProvider[] = [];

  constructor(
    private workspace: string,
    private config: Record<string, unknown>,
  ) {}

  // ── Discovery ──────────────────────────────────────────────────

  /**
   * Auto-discover plugins from node_modules.
   * Looks for packages with "tasksmith-plugin" keyword in package.json.
   */
  async discover(): Promise<string[]> {
    const found: string[] = [];

    // Check node_modules in the workspace and globally
    const searchDirs = [
      join(this.workspace, "node_modules"),
      join(this.workspace, "plugins"), // local plugin dir
    ];

    // Also check global node_modules
    try {
      const { execSync } = await import("node:child_process");
      const globalDir = execSync("npm root -g", { encoding: "utf-8" }).trim();
      if (existsSync(globalDir)) searchDirs.push(globalDir);
    } catch { /* skip */ }

    for (const searchDir of searchDirs) {
      if (!existsSync(searchDir)) continue;

      for (const entry of readdirSync(searchDir, { withFileTypes: true })) {
        const pkgPath = entry.isDirectory()
          ? join(searchDir, entry.name, "package.json")
          : null;

        // Handle scoped packages (@scope/tasksmith-plugin-xxx)
        if (entry.isDirectory() && entry.name.startsWith("@")) {
          try {
            for (const sub of readdirSync(join(searchDir, entry.name), { withFileTypes: true })) {
              if (sub.isDirectory()) {
                const scopedPkg = join(searchDir, entry.name, sub.name, "package.json");
                if (existsSync(scopedPkg)) {
                  const pkg = JSON.parse(readFileSync(scopedPkg, "utf-8"));
                  if (this.isTaskSmithPlugin(pkg)) {
                    found.push(`${entry.name}/${sub.name}`);
                  }
                }
              }
            }
          } catch { /* skip */ }
          continue;
        }

        if (pkgPath && existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            if (this.isTaskSmithPlugin(pkg)) {
              found.push(entry.name);
            }
          } catch { /* skip */ }
        }
      }
    }

    return found;
  }

  private isTaskSmithPlugin(pkg: Record<string, unknown>): boolean {
    const keywords = pkg.keywords as string[] | undefined;
    const name = pkg.name as string | undefined;
    return (
      (keywords?.includes("tasksmith-plugin") ?? false) ||
      (name?.startsWith("tasksmith-plugin-") ?? false) ||
      ("tasksmith" in pkg)
    );
  }

  // ── Loading ────────────────────────────────────────────────────

  /**
   * Load plugins from config.
   * Config format:
   *   plugins:
   *     - tasksmith-plugin-proxmox                    # string shorthand
   *     - name: tasksmith-plugin-proxmox              # object with options
   *       enabled: true
   *       config:
   *         host: "https://pve.lan:8006"
   *     - path: ./my-local-plugin                       # local file path
   */
  async loadFromConfig(): Promise<void> {
    const pluginEntries = (this.config as any).plugins as Array<string | Record<string, unknown>> | undefined;
    if (!pluginEntries || pluginEntries.length === 0) return;

    const { isBundledPlugin, loadBundledPlugin } = await import("./plugins/bundled/index.js");

    for (const entry of pluginEntries) {
      try {
        const name = typeof entry === "string" ? entry : ((entry.name as string) || (entry.path as string) || "");
        if (!name) continue;

        const options = typeof entry === "object" ? ((entry.config as Record<string, unknown>) || {}) : {};

        if (typeof entry === "object" && entry.enabled === false) {
          console.log(`  ${chalk.dim("○")} Plugin disabled: ${name}`);
          continue;
        }

        // Try bundled plugin first
        if (isBundledPlugin(name)) {
          const activate = await loadBundledPlugin(name);
          if (activate) {
            if (this.plugins.has(name)) {
              console.warn(`[plugins] ${name} already loaded, skipping`);
              continue;
            }
            const plugin = { name, manifest: {}, activate, deactivate: undefined, options };
            this.plugins.set(name, plugin);
            console.log(`  ${chalk.green("✓")} Plugin: ${name} ${chalk.dim("(bundled)")}`);
            continue;
          }
        }

        // Fall through to npm/path resolution
        await this.load(name, options);
      } catch (e: any) {
        console.error(`  ${chalk.red("✗")} Plugin load failed: ${e.message}`);
      }
    }
  }

  /**
   * Load a single plugin by name or path.
   */
  async load(nameOrPath: string, options: Record<string, unknown>): Promise<void> {
    if (this.plugins.has(nameOrPath)) {
      console.warn(`[plugins] ${nameOrPath} already loaded, skipping`);
      return;
    }

    let modulePath: string;
    let manifest: PluginManifest = {};

    // Resolve the module
    if (nameOrPath.startsWith("./") || nameOrPath.startsWith("/")) {
      // Local path
      modulePath = resolve(this.workspace, nameOrPath);
    } else {
      // npm package name — resolve from workspace or globally
      const require = createRequire(join(this.workspace, "node_modules", ".package.json"));
      try {
        modulePath = require.resolve(nameOrPath);
      } catch {
        // Try global
        const require2 = createRequire(import.meta.url);
        modulePath = require2.resolve(nameOrPath);
      }
    }

    // Load the manifest from package.json if available
    const pkgDir = this.findPackageRoot(modulePath);
    if (pkgDir) {
      const pkgPath = join(pkgDir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        manifest = (pkg.tasksmith || {}) as PluginManifest;

        // Merge config defaults with user options
        if (manifest.configDefaults) {
          options = { ...manifest.configDefaults, ...options };
        }
      }
    }

    // Import the module
    const mod = await import(modulePath);
    const activate: PluginActivateFn = mod.default || mod.activate;
    const deactivate: PluginDeactivateFn | undefined = mod.deactivate;

    if (typeof activate !== "function") {
      throw new Error(`Plugin ${nameOrPath} does not export an activate function`);
    }

    // Check dependencies
    if (manifest.dependencies) {
      for (const dep of manifest.dependencies) {
        if (!this.plugins.has(dep)) {
          throw new Error(`Plugin ${nameOrPath} requires ${dep}, which is not loaded`);
        }
      }
    }

    // Store the plugin
    const plugin: LoadedPlugin = { name: nameOrPath, manifest, activate, deactivate, options };
    this.plugins.set(nameOrPath, plugin);

    console.log(`  ${chalk.green("✓")} Plugin: ${nameOrPath}`);
  }

  private findPackageRoot(modulePath: string): string | null {
    let dir = dirname(modulePath);
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, "package.json"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  }

  // ── Activation ─────────────────────────────────────────────────

  /**
   * Activate all loaded plugins. Called by the Coordinator after
   * core providers are built but before the engine starts.
   */
  async activateAll(): Promise<void> {
    for (const [name, plugin] of this.plugins) {
      try {
        const ctx = this.createContext(name);
        await plugin.activate(ctx, plugin.options);
      } catch (e: any) {
        console.error(`  ${chalk.red("✗")} Plugin activate failed (${name}): ${e.message}`);
      }
    }
  }

  /**
   * Deactivate all plugins. Called on shutdown.
   */
  async deactivateAll(): Promise<void> {
    for (const [name, plugin] of this.plugins) {
      try {
        await plugin.deactivate?.();
      } catch (e: any) {
        console.error(`[plugins] ${name} deactivate error: ${e.message}`);
      }
    }
  }

  // ── Context Factory ────────────────────────────────────────────

  private createContext(pluginName: string): PluginContext {
    const self = this;
    return {
      workspace: self.workspace,
      config: self.config,

      addOutboundProvider(provider: OutboundCommsProvider) {
        self.additionalOutbound.push(provider);
      },
      addInboundProvider(provider: InboundCommsProvider) {
        self.additionalInbound.push(provider);
      },
      addMemoryProvider(provider: MemoryProvider) {
        self.additionalMemory.push(provider);
      },
      addTemplate(name: string, templateDir: string) {
        // Copy templates to workspace templates dir for engine discovery
        const destDir = join(self.workspace, "templates", name.replace(/-/g, "_"));
        mkdirSync(destDir, { recursive: true });
        // If templateDir is relative, resolve from the plugin's location
        const absDir = resolve(templateDir);
        if (existsSync(absDir)) {
          for (const file of readdirSync(absDir)) {
            copyFileSync(join(absDir, file), join(destDir, file));
          }
        }
        self.templates.set(name, destDir);
      },
      addCommand(name: string, handler: PluginCommandHandler) {
        self.commands.set(name, { pluginName, handler });
      },
      addHook(event: PluginHookEvent, handler: PluginHook) {
        if (!self.hooks.has(event)) self.hooks.set(event, []);
        self.hooks.get(event)!.push({ pluginName, handler });
      },

      log: {
        info: (msg: string) => console.log(`  [${chalk.cyan(pluginName)}] ${msg}`),
        warn: (msg: string) => console.warn(`  [${chalk.yellow(pluginName)}] ${msg}`),
        error: (msg: string) => console.error(`  [${chalk.red(pluginName)}] ${msg}`),
      },
    };
  }

  // ── Accessors (used by Coordinator to wire things in) ──────────

  getOutboundProviders(): OutboundCommsProvider[] { return [...this.additionalOutbound]; }
  getInboundProviders(): InboundCommsProvider[] { return [...this.additionalInbound]; }
  getMemoryProviders(): MemoryProvider[] { return [...this.additionalMemory]; }
  getTemplates(): Map<string, string> { return new Map(this.templates); }
  getCommands(): Map<string, { pluginName: string; handler: PluginCommandHandler }> { return new Map(this.commands); }
  getLoadedPlugins(): string[] { return [...this.plugins.keys()]; }

  /**
   * Execute all hooks for a given event.
   * Returns the (possibly transformed) data.
   */
  async executeHooks(event: PluginHookEvent, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const handlers = this.hooks.get(event) || [];
    let current = { ...data };
    for (const { pluginName, handler } of handlers) {
      try {
        const result = await handler(current);
        if (result && typeof result === "object") {
          current = { ...current, ...result };
        }
      } catch (e: any) {
        console.error(`[hook:${event}] ${pluginName} error: ${e.message}`);
      }
    }
    return current;
  }
}

// =============================================================================
// PLUGIN SCAFFOLDING — `tasksmith plugin create`
// =============================================================================

export function scaffoldPlugin(name: string, targetDir: string): void {
  const pluginName = name.startsWith("tasksmith-plugin-") ? name : `tasksmith-plugin-${name}`;
  const shortName = pluginName.replace("tasksmith-plugin-", "");
  const dir = join(targetDir, pluginName);

  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "templates", `${shortName}-default`), { recursive: true });

  // package.json
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: pluginName,
    version: "0.1.0",
    description: `TaskSmith plugin: ${shortName}`,
    type: "module",
    main: "index.js",
    keywords: ["tasksmith-plugin", shortName],
    tasksmith: {
      provides: {
        templates: [`${shortName}-default`],
      },
      configDefaults: {},
    },
    peerDependencies: {
      tasksmith: ">=0.3.0",
    },
  }, null, 2) + "\n");

  // index.js
  writeFileSync(join(dir, "index.js"), `/**
 * ${pluginName}
 *
 * @param {import('tasksmith').PluginContext} ctx
 * @param {Record<string, unknown>} options
 */
export default function ${camelCase(shortName)}Plugin(forge, options) {
  forge.log.info("${shortName} plugin loaded");

  // Register templates
  forge.addTemplate("${shortName}-default", new URL("./templates/${shortName}-default", import.meta.url).pathname);

  // Register hooks
  forge.addHook("onStartup", async () => {
    forge.log.info("${shortName} ready");
  });

  // Example: register a provider
  // forge.addOutboundProvider(new MyProvider(options));
}
`);

  // Template PROMPT.md
  writeFileSync(join(dir, "templates", `${shortName}-default`, "PROMPT.md"), `# ${shortName}

{{prompt}}

<!-- Add your template instructions here -->
`);

  // README
  writeFileSync(join(dir, "README.md"), `# ${pluginName}

A TaskSmith plugin for ${shortName}.

## Install

\`\`\`bash
npm install ${pluginName}
\`\`\`

## Configure

Add to your \`tasksmith.yaml\`:

\`\`\`yaml
plugins:
  - name: ${pluginName}
    config: {}
\`\`\`

## Usage

\`\`\`bash
tasksmith submit -t ${shortName}-default -p "your prompt here"
\`\`\`
`);

  console.log(chalk.green(`\n  Plugin scaffolded at ${dir}\n`));
  console.log(`  Next steps:`);
  console.log(`    1. cd ${dir}`);
  console.log(`    2. Edit index.js to add your logic`);
  console.log(`    3. Edit templates/${shortName}-default/PROMPT.md`);
  console.log(`    4. npm link (to test locally)`);
  console.log(`    5. npm publish (to share)\n`);
}

function camelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
