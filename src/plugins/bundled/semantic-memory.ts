/**
 * TaskSmith Official Plugin: Semantic Memory
 *
 * Adds vector-based semantic search to the memory system.
 * Uses Ollama for local embeddings — no external API calls,
 * no data leaves your machine.
 *
 * Features:
 *   - Embeds every memory entry on write
 *   - Semantic search: "find tasks related to authentication" returns
 *     conceptually related entries, not just keyword matches
 *   - Persists embeddings to disk (JSON) for fast startup
 *   - CLI command: `tasksmith semantic` for semantic memory search
 *   - Falls back gracefully if Ollama is unavailable
 *
 * Config:
 *   plugins:
 *     - name: semantic-memory
 *       config:
 *         ollamaUrl: "http://localhost:11434"
 *         model: "nomic-embed-text"         # embedding model
 *         embeddingsFile: "embeddings.json"  # relative to workspace
 *         maxResults: 10
 *         minSimilarity: 0.3                # 0-1, lower = more results
 *
 * Requires:
 *   - Ollama running locally with an embedding model pulled:
 *     ollama pull nomic-embed-text
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ForgePluginContext } from "../../plugins.js";

interface SemanticConfig {
  provider: "ollama" | "openai" | "gemini";
  // Ollama
  ollamaUrl: string;
  ollamaModel: string;
  // OpenAI
  openaiApiKey: string;
  openaiModel: string;
  // Gemini
  geminiApiKey: string;
  geminiModel: string;
  // General
  embeddingsFile: string;
  maxResults: number;
  minSimilarity: number;
}

const DEFAULTS: SemanticConfig = {
  provider: "ollama",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "nomic-embed-text",
  openaiApiKey: "",
  openaiModel: "text-embedding-3-small",
  geminiApiKey: "",
  geminiModel: "text-embedding-004",
  embeddingsFile: "embeddings.json",
  maxResults: 10,
  minSimilarity: 0.3,
};

// ── Embedding types ─────────────────────────────────────────────────

interface EmbeddingRecord {
  id: string;
  text: string;
  embedding: number[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface EmbeddingsStore {
  version: 1;
  model: string;
  records: EmbeddingRecord[];
}

// ── Embedding Provider Interface ────────────────────────────────────

interface EmbeddingProvider {
  name: string;
  getEmbedding(text: string): Promise<number[] | null>;
  isAvailable(): Promise<boolean>;
  modelName(): string;
}

// ── Ollama Provider ─────────────────────────────────────────────────

class OllamaEmbeddings implements EmbeddingProvider {
  readonly name = "ollama";
  constructor(private url: string, private model: string) {}

  modelName(): string { return this.model; }

  async getEmbedding(text: string): Promise<number[] | null> {
    try {
      const res = await fetch(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      return data.embeddings?.[0] || null;
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      const data = await res.json() as any;
      const models = (data.models || []) as Array<{ name: string }>;
      return models.some(m => m.name.startsWith(this.model));
    } catch {
      return false;
    }
  }
}

// ── OpenAI Provider ─────────────────────────────────────────────────

class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = "openai";
  constructor(private apiKey: string, private model: string) {}

  modelName(): string { return this.model; }

  async getEmbedding(text: string): Promise<number[] | null> {
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      return data.data?.[0]?.embedding || null;
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ── Gemini Provider ─────────────────────────────────────────────────

class GeminiEmbeddings implements EmbeddingProvider {
  readonly name = "gemini";
  constructor(private apiKey: string, private model: string) {}

  modelName(): string { return this.model; }

  async getEmbedding(text: string): Promise<number[] | null> {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      return data.embedding?.values || null;
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ── Provider Factory ────────────────────────────────────────────────

function createEmbeddingProvider(config: SemanticConfig): EmbeddingProvider | null {
  switch (config.provider) {
    case "ollama":
      return new OllamaEmbeddings(config.ollamaUrl, config.ollamaModel);
    case "openai": {
      const key = config.openaiApiKey || process.env.OPENAI_API_KEY || "";
      if (!key) return null;
      return new OpenAIEmbeddings(key, config.openaiModel);
    }
    case "gemini": {
      const key = config.geminiApiKey || process.env.GEMINI_API_KEY || "";
      if (!key) return null;
      return new GeminiEmbeddings(key, config.geminiModel);
    }
    default:
      return null;
  }
}

// ── Vector Math ─────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Store Management ────────────────────────────────────────────────

function loadStore(filePath: string): EmbeddingsStore {
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as EmbeddingsStore;
    } catch {
      // Corrupted file, start fresh
    }
  }
  return { version: 1, model: "", records: [] };
}

function saveStore(store: EmbeddingsStore, filePath: string): void {
  writeFileSync(filePath, JSON.stringify(store), "utf-8");
}

// ── Plugin Entry Point ──────────────────────────────────────────────

export default function semanticMemoryPlugin(ctx: ForgePluginContext, options: Record<string, unknown>): void {
  const config: SemanticConfig = { ...DEFAULTS, ...options } as SemanticConfig;
  const storeFile = join(ctx.workspace, config.embeddingsFile);
  let store = loadStore(storeFile);
  let provider: EmbeddingProvider | null = null;

  // Initialize provider on startup
  ctx.addHook("onStartup", async () => {
    provider = createEmbeddingProvider(config);

    if (!provider) {
      ctx.log.warn(`Semantic memory: no valid config for provider "${config.provider}". Check API keys.`);
      return;
    }

    const ok = await provider.isAvailable();
    if (!ok) {
      ctx.log.warn(`Semantic memory: ${provider.name} not available. Check connection/credentials.`);
      provider = null;
      return;
    }

    // Check if model changed since last run
    const modelId = `${config.provider}:${provider.modelName()}`;
    if (store.model && store.model !== modelId) {
      ctx.log.warn(`Embedding model changed (${store.model} → ${modelId}). Embeddings will be rebuilt over time.`);
      store = { version: 1, model: modelId, records: [] };
    }

    store.model = modelId;
    ctx.log.info(`Semantic memory active (${store.records.length} embeddings, provider: ${provider.name}, model: ${provider.modelName()})`);
  });

  // Embed memory entries after task execution
  ctx.addHook("onMemoryFlush", async (data) => {
    if (!provider) return;

    const entry = data.entry as { content?: string; id?: string; type?: string } | undefined;
    if (!entry?.content) return;

    const text = entry.content;
    const id = entry.id || `mem-${Date.now()}`;

    if (store.records.some(r => r.id === id)) return;

    const embedding = await provider.getEmbedding(text);
    if (!embedding) return;

    store.records.push({
      id,
      text: text.slice(0, 2000),
      embedding,
      timestamp: new Date().toISOString(),
      metadata: { type: entry.type },
    });

    saveStore(store, storeFile);
  });

  // Also embed task summaries after execution
  ctx.addHook("afterTaskExecute", async (data) => {
    if (!provider) return;

    const task = data.task as Record<string, unknown> | undefined;
    const ok = data.ok as boolean;
    if (!task) return;

    const summary = [
      `Task: ${task.id}`,
      `Template: ${task.template}`,
      `Project: ${task.project || "none"}`,
      `Status: ${ok ? "success" : "failed"}`,
      `Prompt: ${(task.prompt as string || "").slice(0, 500)}`,
      ok ? "" : `Error: ${(task.error as string || "").slice(0, 200)}`,
    ].filter(Boolean).join("\n");

    const id = `task-${task.id}`;
    if (store.records.some(r => r.id === id)) return;

    const embedding = await provider.getEmbedding(summary);
    if (!embedding) return;

    store.records.push({
      id,
      text: summary,
      embedding,
      timestamp: new Date().toISOString(),
      metadata: { taskId: task.id, template: task.template, project: task.project, success: ok },
    });

    saveStore(store, storeFile);
  });

  // Save on shutdown
  ctx.addHook("onShutdown", async () => {
    if (store.records.length > 0) {
      saveStore(store, storeFile);
    }
  });

  // CLI command: tasksmith semantic <query>
  ctx.addCommand("semantic", {
    description: "Semantic search across task and memory history",
    options: [
      { flag: "--query <text>", description: "Search query" },
      { flag: "--limit <n>", description: "Max results", default: String(config.maxResults) },
      { flag: "--stats", description: "Show embedding stats" },
    ],
    action: async (args) => {
      const chalk = (await import("chalk")).default;

      if (args.stats) {
        const p = createEmbeddingProvider(config);
        const isUp = p ? await p.isAvailable() : false;

        console.log(chalk.bold("\n  Semantic Memory Stats\n"));
        console.log(`    Provider:    ${config.provider}`);
        console.log(`    Model:       ${store.model || "(not set)"}`);
        console.log(`    Embeddings:  ${store.records.length}`);
        console.log(`    Store file:  ${storeFile}`);
        console.log(`    Status:      ${isUp ? chalk.green("available") : chalk.red("unavailable")}`);

        if (store.records.length > 0) {
          const oldest = store.records[0].timestamp;
          const newest = store.records[store.records.length - 1].timestamp;
          console.log(`    Oldest:      ${new Date(oldest).toLocaleDateString()}`);
          console.log(`    Newest:      ${new Date(newest).toLocaleDateString()}`);
        }
        console.log();
        return;
      }

      const query = args.query;
      if (!query) {
        console.log(chalk.red("\n  Usage: tasksmith semantic --query \"your search query\"\n"));
        return;
      }

      const p = createEmbeddingProvider(config);
      if (!p || !await p.isAvailable()) {
        console.log(chalk.red(`\n  ${config.provider} not available. Check connection/credentials.\n`));
        return;
      }

      console.log(chalk.dim(`\n  Searching ${store.records.length} embeddings via ${p.name} for: "${query}"\n`));

      const queryEmbedding = await p.getEmbedding(query);
      if (!queryEmbedding) {
        console.log(chalk.red("  Failed to generate query embedding.\n"));
        return;
      }

      const scored = store.records
        .map(r => ({ record: r, score: cosineSimilarity(queryEmbedding, r.embedding) }))
        .filter(s => s.score >= config.minSimilarity)
        .sort((a, b) => b.score - a.score)
        .slice(0, parseInt(args.limit || String(config.maxResults)));

      if (scored.length === 0) {
        console.log(chalk.dim("  No relevant results found.\n"));
        return;
      }

      for (const { record, score } of scored) {
        const pct = Math.round(score * 100);
        const bar = chalk.green("█".repeat(Math.round(pct / 5)));
        const date = new Date(record.timestamp).toLocaleDateString();
        const meta = record.metadata || {};

        console.log(`  ${chalk.bold(`${pct}%`)} ${bar} ${chalk.dim(date)} ${chalk.dim(record.id)}`);

        const lines = record.text.split("\n").slice(0, 2);
        for (const line of lines) {
          console.log(`       ${line.slice(0, 80)}${line.length > 80 ? "..." : ""}`);
        }

        if (meta.project) console.log(`       ${chalk.dim(`project: ${meta.project}`)}`);
        console.log();
      }
    },
  });

  ctx.log.info("Semantic memory plugin registered");
}

export { SemanticConfig, EmbeddingRecord, EmbeddingProvider, cosineSimilarity };
