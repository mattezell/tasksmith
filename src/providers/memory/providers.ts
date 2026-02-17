/**
 * Memory Providers
 *
 * Hot: MEMORY.md + daily logs (always loaded)
 * Warm: JSONL structured logs (always on) + optional backends
 * Cold: Compressed session archives
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  appendFileSync, readdirSync, createWriteStream,
} from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { MemoryProvider, MemoryEntry, MemorySearchResult } from "../../types.js";

// =============================================================================
// HOT MEMORY: Markdown files
// =============================================================================

export class MarkdownMemoryProvider implements MemoryProvider {
  readonly name = "markdown";
  private memoryFile: string;
  private dailyDir: string;
  private loadDays: number;

  constructor(config: Record<string, unknown>, baseDir: string) {
    this.memoryFile = join(baseDir, (config.memoryFile as string) || "directives/MEMORY.md");
    this.dailyDir = join(baseDir, (config.dailyLogDir as string) || "memory");
    this.loadDays = (config.loadDays as number) || 2;
  }

  async initialize(): Promise<void> {
    mkdirSync(join(this.memoryFile, ".."), { recursive: true });
    mkdirSync(this.dailyDir, { recursive: true });
    if (!existsSync(this.memoryFile)) {
      writeFileSync(this.memoryFile, "# Memory\n\n<!-- Durable facts, decisions, preferences. Auto-updated. Edit freely. -->\n\n");
    }
  }

  async store(entry: MemoryEntry): Promise<boolean> {
    const today = new Date().toISOString().split("T")[0];
    const dailyFile = join(this.dailyDir, `${today}.md`);

    if (!existsSync(dailyFile)) {
      writeFileSync(dailyFile, `# Daily Log: ${today}\n\n`);
    }

    const ts = entry.timestamp.toTimeString().slice(0, 5);
    appendFileSync(dailyFile, `- [${ts}] [${entry.category}] ${entry.content}\n`);
    return true;
  }

  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];
    const ql = query.toLowerCase();

    // Search MEMORY.md
    if (existsSync(this.memoryFile)) {
      for (const line of readFileSync(this.memoryFile, "utf-8").split("\n")) {
        if (ql && line.toLowerCase().includes(ql) && line.trim()) {
          results.push({ content: line.trim(), score: 1.0, source: this.memoryFile, timestamp: new Date() });
        }
      }
    }

    // Search daily logs (most recent first)
    const files = readdirSync(this.dailyDir).filter(f => f.endsWith(".md")).sort().reverse();
    for (const file of files) {
      if (results.length >= limit) break;
      const content = readFileSync(join(this.dailyDir, file), "utf-8");
      for (const line of content.split("\n")) {
        if (line.toLowerCase().includes(ql) && line.startsWith("- [")) {
          results.push({ content: line.trim(), score: 0.8, source: file, timestamp: new Date() });
          if (results.length >= limit) break;
        }
      }
    }

    return results.slice(0, limit);
  }

  async getRecent(limit = 10): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    const files = readdirSync(this.dailyDir).filter(f => f.endsWith(".md")).sort().reverse();

    for (const file of files) {
      const lines = readFileSync(join(this.dailyDir, file), "utf-8").split("\n").reverse();
      for (const line of lines) {
        if (line.startsWith("- [")) {
          entries.push({ content: line.replace(/^- /, ""), source: file, category: "general", importance: 0.5, timestamp: new Date() });
          if (entries.length >= limit) return entries;
        }
      }
    }
    return entries;
  }

  /** Assemble hot memory for context injection into prompts. */
  getHotContext(): string {
    const parts: string[] = [];

    if (existsSync(this.memoryFile)) {
      const c = readFileSync(this.memoryFile, "utf-8").trim();
      if (c) parts.push(`## Durable Memory\n${c}`);
    }

    const today = new Date();
    for (let i = 0; i < this.loadDays; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const f = join(this.dailyDir, `${dateStr}.md`);
      if (existsSync(f)) {
        const c = readFileSync(f, "utf-8").trim();
        if (c) {
          const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : dateStr;
          parts.push(`## ${label}'s Log\n${c}`);
        }
      }
    }

    return parts.join("\n\n");
  }
}

// =============================================================================
// WARM MEMORY: JSONL logs
// =============================================================================

export class JSONLMemoryProvider implements MemoryProvider {
  readonly name = "jsonl_logs";
  private logDir: string;

  constructor(config: Record<string, unknown>, baseDir: string) {
    this.logDir = join(baseDir, (config.logDir as string) || "memory/logs");
  }

  async initialize(): Promise<void> {
    mkdirSync(this.logDir, { recursive: true });
  }

  async store(entry: MemoryEntry): Promise<boolean> {
    const today = new Date().toISOString().split("T")[0];
    const file = join(this.logDir, `${today}.jsonl`);
    const record = {
      content: entry.content,
      source: entry.source,
      category: entry.category,
      importance: entry.importance,
      ts: entry.timestamp.toISOString(),
      meta: entry.metadata || {},
    };
    appendFileSync(file, JSON.stringify(record) + "\n");
    return true;
  }

  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];
    const ql = query.toLowerCase();
    const files = readdirSync(this.logDir).filter(f => f.endsWith(".jsonl")).sort().reverse();

    for (const file of files) {
      const lines = readFileSync(join(this.logDir, file), "utf-8").split("\n").filter(Boolean).reverse();
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if ((r.content || "").toLowerCase().includes(ql)) {
            results.push({ content: r.content, score: 0.7, source: r.source || "", timestamp: new Date(r.ts), metadata: r.meta });
            if (results.length >= limit) return results;
          }
        } catch { /* skip malformed lines */ }
      }
    }
    return results;
  }

  async getRecent(limit = 10): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    const files = readdirSync(this.logDir).filter(f => f.endsWith(".jsonl")).sort().reverse();

    for (const file of files) {
      const lines = readFileSync(join(this.logDir, file), "utf-8").split("\n").filter(Boolean).reverse();
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          entries.push({ content: r.content, source: r.source || "", category: r.category || "general", importance: r.importance || 0.5, timestamp: new Date(r.ts) });
          if (entries.length >= limit) return entries;
        } catch { /* skip */ }
      }
    }
    return entries;
  }
}

// =============================================================================
// COLD MEMORY: Session Archives
// =============================================================================

export class SessionArchiver {
  private archiveDir: string;
  private compress: boolean;

  constructor(config: Record<string, unknown>, baseDir: string) {
    this.archiveDir = join(baseDir, (config.archiveDir as string) || "memory/sessions");
    this.compress = (config.compress as boolean) ?? true;
  }

  initialize(): void {
    mkdirSync(this.archiveDir, { recursive: true });
  }

  async archive(taskId: string, data: Record<string, unknown>): Promise<string> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const jsonStr = JSON.stringify(data, null, 2);

    if (this.compress) {
      const fp = join(this.archiveDir, `${ts}_${taskId}.json.gz`);
      const source = Readable.from(Buffer.from(jsonStr));
      const gzip = createGzip();
      const dest = createWriteStream(fp);
      await pipeline(source, gzip, dest);
      return fp;
    } else {
      const fp = join(this.archiveDir, `${ts}_${taskId}.json`);
      writeFileSync(fp, jsonStr);
      return fp;
    }
  }
}

// =============================================================================
// REGISTRY
// =============================================================================

export const MEMORY_REGISTRY: Record<string, new (config: Record<string, unknown>, baseDir: string) => MemoryProvider> = {
  markdown: MarkdownMemoryProvider,
  jsonl_logs: JSONLMemoryProvider,
};
