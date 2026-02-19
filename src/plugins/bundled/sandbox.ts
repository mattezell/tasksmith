/**
 * TaskSmith Sandbox Plugin
 *
 * Wraps Claude Code invocations in OS-level isolation via
 * @anthropic-ai/sandbox-runtime. Uses bubblewrap (Linux/WSL2) and
 * Seatbelt (macOS) — same primitives Claude Code uses internally.
 * No containers. No Docker daemon.
 *
 * Enable in config:
 *
 *   plugins:
 *     - name: sandbox
 *       config:
 *         enabled: false                   # opt-in per task (recommended)
 *         allowUnsandboxedCommands: false  # lock the escape hatch
 *
 * Per-task opt-in:
 *   params:
 *     sandbox: true
 *     sandbox_domains: ["pypi.org"]
 *
 * Per-task opt-out (when globally enabled):
 *   params:
 *     sandbox: false
 */

import { platform } from "node:os";
import { writeFile, mkdtemp, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PluginContext } from "../../plugins.js";
import type { Task } from "../../types.js";

// =============================================================================
// CONFIG
// =============================================================================

interface SandboxOptions {
  enabled?: boolean;
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowWrite?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  allowUnsandboxedCommands?: boolean;
  logViolations?: boolean;
}

// =============================================================================
// DEFAULTS
// =============================================================================

// Always included — Claude Code needs these to function
const DEFAULT_ALLOWED_DOMAINS = [
  "api.anthropic.com",
  "statsig.anthropic.com",
  "sentry.io",
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "*.github.com",
  "api.github.com",
  "objects.githubusercontent.com",
];

// Always blocked at read level
const DEFAULT_DENY_READ = [
  "~/.ssh",
  "~/.aws",
  "~/.config/gcloud",
  "~/.gnupg",
  "~/.netrc",
];

// Always blocked at write level
const DEFAULT_DENY_WRITE = [
  ".env",
  ".env.*",
  "~/.bashrc",
  "~/.zshrc",
  "~/.profile",
  "~/.bash_profile",
];

// =============================================================================
// PLATFORM CHECK
// =============================================================================

function getPlatformSupport(): { supported: boolean; reason?: string } {
  const os = platform();
  if (os === "linux" || os === "darwin") return { supported: true };
  if (os === "win32") {
    return {
      supported: false,
      reason: "Native Windows not supported by @anthropic-ai/sandbox-runtime. Use WSL2.",
    };
  }
  return { supported: false, reason: `Unsupported platform: ${os}` };
}

// =============================================================================
// SRT SETTINGS BUILDER
// =============================================================================

interface SrtSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  ignoreViolations?: {
    allowUnsandboxedCommands: boolean;
  };
}

function buildSettings(options: SandboxOptions, extraDomains: string[] = []): SrtSettings {
  return {
    network: {
      allowedDomains: [...new Set([
        ...DEFAULT_ALLOWED_DOMAINS,
        ...(options.allowedDomains ?? []),
        ...extraDomains,
      ])],
      deniedDomains: options.deniedDomains ?? [],
      allowLocalBinding: true, // Claude Code internal proxy requires this
    },
    filesystem: {
      denyRead: [...DEFAULT_DENY_READ, ...(options.denyRead ?? [])],
      allowWrite: [".", "/tmp", ...(options.allowWrite ?? [])],
      denyWrite: [...DEFAULT_DENY_WRITE, ...(options.denyWrite ?? [])],
    },
    ignoreViolations: {
      // false = escape hatch LOCKED. Strongly recommended.
      allowUnsandboxedCommands: options.allowUnsandboxedCommands ?? false,
    },
  };
}

// =============================================================================
// COMMAND WRAPPER
// =============================================================================

/**
 * Write a per-task srt settings file and return the wrapped command.
 * Per-task files (rather than ~/.srt-settings.json) prevent parallel
 * workers with different configs from colliding.
 */
async function wrapCommand(
  command: string,
  settings: SrtSettings,
  taskId: string,
  log: PluginContext["log"],
): Promise<{ wrappedCommand: string; settingsPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), `ts-sandbox-${taskId}-`));
  const settingsPath = join(dir, "srt-settings.json");
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");

  // Prefer programmatic SandboxManager — cleaner, no npx overhead
  try {
    // Dynamic import — package is optional, not bundled
    const srt = await (Function('return import("@anthropic-ai/sandbox-runtime")')() as Promise<any>);
    const { SandboxManager } = srt;
    await SandboxManager.initialize({
      network: {
        allowedDomains: settings.network.allowedDomains,
        deniedDomains: settings.network.deniedDomains,
        allowLocalBinding: settings.network.allowLocalBinding,
      },
      filesystem: {
        denyRead: settings.filesystem.denyRead,
        allowWrite: settings.filesystem.allowWrite,
        denyWrite: settings.filesystem.denyWrite,
      },
    });
    const wrapped = await SandboxManager.wrapWithSandbox(command);
    log.info(`Sandbox active (SandboxManager) — escape hatch locked: ${!settings.ignoreViolations?.allowUnsandboxedCommands}`);
    return { wrappedCommand: wrapped, settingsPath };
  } catch {
    // Package not installed — fall back to srt CLI via npx
    log.info(`Sandbox active (npx srt) — escape hatch locked: ${!settings.ignoreViolations?.allowUnsandboxedCommands}`);
    return {
      wrappedCommand: `npx --yes srt --settings ${settingsPath} ${command}`,
      settingsPath,
    };
  }
}

async function cleanupSettingsFile(settingsPath: string): Promise<void> {
  try {
    await unlink(settingsPath);
    await rmdir(join(settingsPath, ".."));
  } catch { /* best-effort */ }
}

async function logViolations(log: PluginContext["log"]): Promise<void> {
  try {
    const srt = await (Function('return import("@anthropic-ai/sandbox-runtime")')() as Promise<any>);
    const { SandboxViolationStore } = srt;
    const violations = await (SandboxViolationStore as any).getAll?.() ?? [];
    if (violations.length > 0) {
      log.warn(`${violations.length} sandbox violation(s) recorded:`);
      for (const v of violations) log.warn(`  ${JSON.stringify(v)}`);
    } else {
      log.info("No sandbox violations recorded.");
    }
  } catch { /* package not installed, skip */ }
}

async function resetSandboxManager(): Promise<void> {
  try {
    const srt = await (Function('return import("@anthropic-ai/sandbox-runtime")')() as Promise<any>);
    const { SandboxManager } = srt;
    await (SandboxManager as any).reset?.();
  } catch { /* not installed */ }
}

// =============================================================================
// STATE — per-task sandbox metadata
// Keyed by task.id so parallel workers don't collide
// =============================================================================

const taskSandboxState = new Map<string, {
  active: boolean;
  settingsPath?: string;
  logViolations: boolean;
}>();

// =============================================================================
// PLUGIN ACTIVATE FUNCTION
// =============================================================================

export default async function sandboxPlugin(
  ctx: PluginContext,
  options: Record<string, unknown>,
): Promise<void> {
  const cfg = options as SandboxOptions;

  // Platform check at activation time — warn early, don't fail
  const { supported, reason } = getPlatformSupport();
  if (!supported) {
    ctx.log.warn(`Sandbox plugin loaded but platform unsupported: ${reason}`);
    ctx.log.warn("Tasks with params.sandbox: true will skip sandboxing silently.");
  }

  ctx.log.info(`Sandbox plugin active. Default: ${cfg.enabled ? "all tasks sandboxed" : "opt-in (params.sandbox: true)"}`);

  // Register the command wrapper hook
  ctx.addCommandWrapper(async (command: string, task: Task): Promise<string> => {
    // Resolve whether this task should be sandboxed
    const taskOptIn = task.params.sandbox;
    const shouldSandbox = taskOptIn !== undefined
      ? Boolean(taskOptIn)
      : Boolean(cfg.enabled);

    if (!shouldSandbox) return command; // pass-through, no wrapping

    if (!supported) {
      ctx.log.warn(`[${task.id}] Skipping sandbox — ${reason}`);
      return command;
    }

    const extraDomains = (task.params.sandbox_domains as string[] | undefined) ?? [];
    const settings = buildSettings(cfg, extraDomains);

    const { wrappedCommand, settingsPath } = await wrapCommand(
      command,
      settings,
      task.id,
      ctx.log,
    );

    // Stash state for cleanup hooks
    taskSandboxState.set(task.id, {
      active: true,
      settingsPath,
      logViolations: cfg.logViolations !== false,
    });

    return wrappedCommand;
  });

  // Post-task cleanup via lifecycle hooks
  ctx.addHook("afterTaskExecute", async (data) => {
    const taskId = data.taskId as string | undefined;
    if (!taskId) return;

    const state = taskSandboxState.get(taskId);
    if (!state?.active) return;

    if (state.logViolations) await logViolations(ctx.log);
    if (state.settingsPath) await cleanupSettingsFile(state.settingsPath);
    await resetSandboxManager();
    taskSandboxState.delete(taskId);
  });
}
