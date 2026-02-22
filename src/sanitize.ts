/**
 * Input Sanitization — validates and cleans task data from external sources.
 *
 * External sources (REST API, Discord bot, watched folders) pass user-controlled
 * data that could contain path traversal, command injection, or permission
 * escalation attempts. This module provides an allowlist-based validation layer
 * that sits between inbound providers and the engine.
 *
 * Trust levels:
 *   - "local"    — file_drop, CLI submit (user placed the file themselves)
 *   - "external" — REST API, Discord bot, watched folders
 *
 * Local sources get light validation (type coercion, path safety).
 * External sources get strict validation (no permission overrides, command allowlist).
 */

// =============================================================================
// TYPES
// =============================================================================

export type TrustLevel = "local" | "external";

export interface SanitizeResult {
  /** The sanitized data (mutated copy). */
  data: Record<string, any>;
  /** Warnings generated during sanitization (fields stripped, values clamped, etc.). */
  warnings: string[];
  /** If true, the task was rejected entirely (e.g. missing required fields). */
  rejected: boolean;
  /** Rejection reason, if rejected. */
  reason?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Allowed template names (normalized to underscore form). */
const KNOWN_TEMPLATES = new Set([
  "ralph_loop", "ralph-loop",
  "bug_hunt", "bug-hunt",
  "code_review", "code-review",
  "research",
  "project_init", "project-init",
  "doc_gen", "doc-gen",
  "heartbeat",
]);

/** Allowed model values. */
const KNOWN_MODELS = new Set([
  "auto", "sonnet", "opus", "haiku",
  "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001",
]);

/** Allowed priority values. */
const KNOWN_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

/**
 * Params that external sources are NOT allowed to set.
 * These control security-sensitive behavior and must only come from
 * config files or local (trusted) task submissions.
 */
const RESTRICTED_PARAMS = new Set([
  "permission_mode",
  "allowed_tools",
  "disallowed_tools",
  "sandbox",
  "sandbox_domains",
  "allowUnsandboxedCommands",
]);

/**
 * Validation command allowlist — base commands that are safe to run.
 * The full command is checked: only the first token (the executable) must
 * appear in this list. Arguments are allowed but shell metacharacters are
 * stripped to prevent injection.
 */
const ALLOWED_VALIDATION_COMMANDS = new Set([
  "npm", "npx", "node", "yarn", "pnpm", "bun",
  "python", "python3", "pip", "pytest", "mypy", "ruff", "black", "flake8",
  "cargo", "rustc",
  "go", "golangci-lint",
  "make", "cmake",
  "tsc", "eslint", "prettier", "vitest", "jest", "mocha",
  "dotnet", "msbuild",
  "gradle", "mvn",
  "swift", "xcodebuild",
  "ruby", "bundle", "rake", "rspec",
  "mix", "elixir",
  "zig",
  "deno",
]);

/**
 * Shell metacharacters that enable command chaining/injection.
 * These are stripped from validation commands from external sources.
 */
const DANGEROUS_SHELL_CHARS = /[;&|`$(){}!<>\n\r\\]/g;

/** Max lengths for string fields to prevent memory/log abuse. */
const MAX_LENGTHS: Record<string, number> = {
  prompt: 50_000,
  project: 100,
  template: 50,
  model: 50,
  id: 100,
  validation_command: 500,
};

// =============================================================================
// SANITIZE FUNCTIONS
// =============================================================================

/**
 * Sanitize a project name. Prevents path traversal and restricts to
 * filesystem-safe characters.
 */
function sanitizeProjectName(project: string): { value: string; warning?: string } {
  if (!project) return { value: "" };

  const original = project;

  // Strip path traversal
  let clean = project.replace(/\.\./g, "").replace(/[/\\]/g, "");

  // Only allow alphanumeric, hyphens, underscores, dots
  clean = clean.replace(/[^a-zA-Z0-9._-]/g, "");

  // Strip leading dots (hidden dirs)
  clean = clean.replace(/^\.+/, "");

  // Clamp length
  clean = clean.slice(0, MAX_LENGTHS.project);

  if (clean !== original) {
    return { value: clean, warning: `Project name sanitized: "${original}" -> "${clean}"` };
  }
  return { value: clean };
}

/**
 * Sanitize a validation command. For external sources, only allows known
 * executables and strips shell metacharacters. Local sources get lighter
 * treatment (metacharacter stripping only).
 */
function sanitizeValidationCommand(
  cmd: string,
  trust: TrustLevel,
): { value: string | null; warning?: string } {
  if (!cmd || typeof cmd !== "string") return { value: null };

  const trimmed = cmd.trim();
  if (!trimmed) return { value: null };

  // Clamp length
  if (trimmed.length > MAX_LENGTHS.validation_command) {
    return {
      value: null,
      warning: `Validation command too long (${trimmed.length} chars, max ${MAX_LENGTHS.validation_command}). Stripped.`,
    };
  }

  // Strip dangerous shell characters
  const cleaned = trimmed.replace(DANGEROUS_SHELL_CHARS, "");

  // Extract base command (first token)
  const baseCmd = cleaned.split(/\s+/)[0];

  if (trust === "external") {
    if (!ALLOWED_VALIDATION_COMMANDS.has(baseCmd)) {
      return {
        value: null,
        warning: `Validation command "${baseCmd}" not in allowlist. Stripped from external task.`,
      };
    }
  }

  if (cleaned !== trimmed) {
    return {
      value: cleaned,
      warning: `Shell metacharacters stripped from validation command: "${trimmed}" -> "${cleaned}"`,
    };
  }

  return { value: cleaned };
}

/**
 * Determine the trust level of a given inbound source.
 */
export function trustLevel(source: string): TrustLevel {
  switch (source) {
    case "file_drop":
    case "cli":
    case "local":
    case "scanInbox":
      return "local";
    case "mcp":
    case "rest_api":
    case "discord_bot":
    case "watched_folder":
      return "external";
    default:
      return "external";
  }
}

/**
 * Main sanitization entry point. Validates and cleans a parsed task data object.
 *
 * @param raw     The parsed task data (from YAML/JSON)
 * @param source  The inbound source name (e.g. "rest_api", "discord_bot", "file_drop")
 * @returns       Sanitized data, warnings, and rejection status
 */
export function sanitizeTask(raw: Record<string, any>, source: string): SanitizeResult {
  const trust = trustLevel(source);
  const warnings: string[] = [];
  const data = { ...raw };

  // ── Required fields ──────────────────────────────────────────────

  if (!data.prompt && !data.template) {
    return { data, warnings, rejected: true, reason: "Task must have a 'prompt' or 'template' field." };
  }

  // ── String field type coercion + length clamping ─────────────────

  for (const field of ["prompt", "template", "model", "project", "id"] as const) {
    if (data[field] != null) {
      data[field] = String(data[field]);
      const max = MAX_LENGTHS[field];
      if (max && data[field].length > max) {
        data[field] = data[field].slice(0, max);
        warnings.push(`Field '${field}' truncated to ${max} characters.`);
      }
    }
  }

  // ── Template validation ──────────────────────────────────────────

  if (data.template && trust === "external" && !KNOWN_TEMPLATES.has(data.template)) {
    // Allow custom templates from local sources, but external must use known ones
    // to prevent filesystem probing via template resolution
    warnings.push(`Unknown template "${data.template}" from external source. Defaulting to "ralph-loop".`);
    data.template = "ralph-loop";
  }

  // ── Model validation ─────────────────────────────────────────────

  if (data.model) {
    if (!KNOWN_MODELS.has(data.model)) {
      warnings.push(`Unknown model "${data.model}". Defaulting to "sonnet".`);
      data.model = "sonnet";
    }
  }

  // ── Priority validation ──────────────────────────────────────────

  if (data.priority) {
    if (!KNOWN_PRIORITIES.has(data.priority)) {
      warnings.push(`Unknown priority "${data.priority}". Defaulting to "normal".`);
      data.priority = "normal";
    }
  }

  // ── Project name sanitization ────────────────────────────────────

  if (data.project) {
    const { value, warning } = sanitizeProjectName(data.project);
    data.project = value;
    if (warning) warnings.push(warning);
  }

  // ── max_iterations clamping ──────────────────────────────────────

  const maxIter = data.max_iterations ?? data.maxIterations;
  if (maxIter != null) {
    const n = Number(maxIter);
    if (isNaN(n) || n < 1) {
      data.max_iterations = 1;
      warnings.push(`max_iterations must be a positive number. Set to 1.`);
    } else if (n > 20) {
      data.max_iterations = 20;
      warnings.push(`max_iterations capped at 20 (was ${n}).`);
    } else {
      data.max_iterations = Math.floor(n);
    }
    if ("maxIterations" in data) data.maxIterations = data.max_iterations;
  }

  // ── Params sanitization ──────────────────────────────────────────

  if (data.params && typeof data.params === "object") {
    data.params = sanitizeParams(data.params, trust, warnings);
  } else if (data.params != null) {
    warnings.push("'params' must be an object. Replaced with empty object.");
    data.params = {};
  }

  // ── notify field ─────────────────────────────────────────────────

  if (data.notify != null) {
    if (!Array.isArray(data.notify)) {
      if (typeof data.notify === "string") {
        data.notify = [data.notify];
      } else {
        data.notify = ["all"];
        warnings.push("'notify' must be an array of strings. Defaulted to ['all'].");
      }
    }
  }

  return { data, warnings, rejected: false };
}

/**
 * Sanitize task params. Strips restricted keys from external sources,
 * validates validation_command, and enforces type safety.
 */
function sanitizeParams(
  params: Record<string, any>,
  trust: TrustLevel,
  warnings: string[],
): Record<string, any> {
  const clean: Record<string, any> = {};

  for (const [key, value] of Object.entries(params)) {
    // Block restricted params from external sources
    if (trust === "external" && RESTRICTED_PARAMS.has(key)) {
      warnings.push(`Restricted param '${key}' stripped (external source).`);
      continue;
    }

    // Sanitize validation_command specifically
    if (key === "validation_command") {
      const { value: sanitized, warning } = sanitizeValidationCommand(
        String(value),
        trust,
      );
      if (warning) warnings.push(warning);
      if (sanitized) {
        clean[key] = sanitized;
      }
      continue;
    }

    // Sanitize cooldown_seconds
    if (key === "cooldown_seconds") {
      const n = Number(value);
      if (isNaN(n) || n < 0) {
        clean[key] = 5;
        warnings.push("cooldown_seconds must be a non-negative number. Set to 5.");
      } else {
        clean[key] = Math.min(n, 300); // Cap at 5 minutes
      }
      continue;
    }

    // General param: allow through with basic type checking
    // Block excessively large string values
    if (typeof value === "string" && value.length > 10_000) {
      clean[key] = value.slice(0, 10_000);
      warnings.push(`Param '${key}' truncated to 10000 characters.`);
    } else {
      clean[key] = value;
    }
  }

  return clean;
}
