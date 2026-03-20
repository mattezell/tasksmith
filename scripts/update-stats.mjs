#!/usr/bin/env node
/**
 * TaskSmith Line Count Updater
 *
 * Counts core and plugin lines, then updates all references across:
 *   - site/index.html (OG meta, numbers section, creator bio)
 *   - README.md (hero, architecture section)
 *   - CHANGELOG.md (latest entry if needed)
 *
 * Run: node scripts/update-stats.mjs
 * Or:  npm run stats
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Count lines ─────────────────────────────────────────────────────

function countLines(dir, extensions = [".ts"]) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += countLines(fullPath, extensions);
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      const content = readFileSync(fullPath, "utf-8");
      total += content.split("\n").length;
    }
  }
  return total;
}

// Core = src/*.ts + src/providers/**/*.ts (excludes src/plugins/)
function countCore() {
  let total = 0;
  const srcDir = join(ROOT, "src");

  // Top-level .ts files
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      total += readFileSync(join(srcDir, entry.name), "utf-8").split("\n").length;
    }
  }

  // Providers
  const providersDir = join(srcDir, "providers");
  total += countLines(providersDir);

  return total;
}

function countPlugins() {
  return countLines(join(ROOT, "src", "plugins", "bundled"));
}

function countPluginFiles() {
  const dir = join(ROOT, "src", "plugins", "bundled");
  return readdirSync(dir).filter(f => f.endsWith(".ts") && f !== "index.ts").length;
}

// ── Marketing bucket ────────────────────────────────────────────────

function marketingBucket(lines) {
  if (lines < 5000) return "under 5,000";
  if (lines < 6000) return "under 6,000";
  if (lines < 8000) return "under 8,000";
  if (lines < 10000) return "under 10,000";
  if (lines < 25000) return "under 25,000";
  if (lines < 50000) return "under 50,000";
  if (lines < 100000) return "under 100,000";
  return `~${Math.round(lines / 1000)}k`;
}

function marketingBucketShort(lines) {
  if (lines < 5000) return "<5k";
  if (lines < 6000) return "<6k";
  if (lines < 8000) return "<8k";
  if (lines < 10000) return "<10k";
  if (lines < 25000) return "<25k";
  if (lines < 50000) return "<50k";
  if (lines < 100000) return "<100k";
  return `~${Math.round(lines / 1000)}k`;
}

// ── Update files ────────────────────────────────────────────────────

function updateFile(filePath, replacements) {
  if (!statSync(filePath, { throwIfNoEntry: false })) return false;
  let content = readFileSync(filePath, "utf-8");
  let changed = false;

  for (const [pattern, replacement] of replacements) {
    const regex = typeof pattern === "string" ? new RegExp(escapeRegex(pattern), "g") : pattern;
    const newContent = content.replace(regex, replacement);
    if (newContent !== content) {
      content = newContent;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(filePath, content);
    return true;
  }
  return false;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Main ────────────────────────────────────────────────────────────

const coreLines = countCore();
const pluginLines = countPlugins();
const pluginCount = countPluginFiles();
const totalLines = coreLines + pluginLines;
const bucket = marketingBucket(coreLines);
const bucketShort = marketingBucketShort(coreLines);

console.log(`
  TaskSmith Stats
  ───────────────
  Core:      ${coreLines.toLocaleString()} lines
  Plugins:   ${pluginLines.toLocaleString()} lines (${pluginCount} plugins)
  Total:     ${totalLines.toLocaleString()} lines
  Marketing: "${bucket}" / "${bucketShort}"
`);

// Patterns that match various ways we've expressed the line count
const corePatterns = [
  // "Under X,XXX lines of core TypeScript" — careful not to duplicate "under"
  [/[Uu]nder [\d,]+ lines of core TypeScript/g, `Under ${bucket.replace(/^[Uu]nder /, "")} lines of core TypeScript`],
  // "<Xk lines" in titles/short form
  [/<\d+k lines of core TypeScript/g, `${bucketShort} lines of core TypeScript`],
];

const pluginPatterns = [
  [/\d+ bundled plugins/g, `${pluginCount} bundled plugins`],
  [/\d+ official plugins/g, `${pluginCount} official plugins`],
];

const exactCorePatterns = [
  // README architecture: "**X,XXX lines of core TypeScript**"
  [/\*\*[\d,]+ lines of core TypeScript\*\*/g, `**${coreLines.toLocaleString()} lines of core TypeScript**`],
  // Plugin lines: "X,XXX lines across N bundled plugins"
  [/[\d,]+ lines across \d+ bundled plugins/g, `${pluginLines.toLocaleString()} lines across ${pluginCount} bundled plugins`],
];

// site/index.html
const siteFile = join(ROOT, "site", "index.html");
const siteUpdated = updateFile(siteFile, [
  // OG meta
  [/Turn Claude Code into a task engine\. [^"]+lines[^"]*\./g,
   `Turn Claude Code into a task engine. ${bucket} lines of core TypeScript. Zero bloat.`],
  // Numbers section - the <Xk or "under X" display
  [/<div class="num">[^<]*<\/div><div class="num-label">Lines of core TypeScript<\/div>/g,
   `<div class="num">${bucketShort}</div><div class="num-label">Lines of core TypeScript</div>`],
  // Numbers section - plugin count
  [/<div class="num">\d+<\/div><div class="num-label">Official plugins<\/div>/g,
   `<div class="num">${pluginCount}</div><div class="num-label">Official plugins</div>`],
  // Plugin section headline
  [/\d+ plugins\.<br>Zero installs\./g,
   `${pluginCount} plugins.<br>Zero installs.`],
  ...corePatterns,
  ...pluginPatterns,
]);

// README.md
const readmeFile = join(ROOT, "README.md");
const readmeUpdated = updateFile(readmeFile, [
  ...corePatterns,
  ...pluginPatterns,
  ...exactCorePatterns,
]);

console.log(`  Files updated:`);
console.log(`    site/index.html: ${siteUpdated ? "✓" : "no changes"}`);
console.log(`    README.md:       ${readmeUpdated ? "✓" : "no changes"}`);
console.log();
