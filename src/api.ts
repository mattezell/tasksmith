/**
 * TaskSmith REST API — Fastify server
 *
 * POST   /tasks              Submit a task
 * GET    /tasks              List tasks by status
 * GET    /tasks/:id          Get task details
 * DELETE /tasks/:id          Cancel a task
 * GET    /health             System health
 * POST   /memory/search      Search memory
 * GET    /status             Full system status
 */

import Fastify from "fastify";
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import yaml from "js-yaml";
import type { TaskEngine } from "./engine.js";
import type { MemoryProvider } from "./types.js";
import { sanitizeTask } from "./sanitize.js";

export interface APIServerConfig {
  host?: string;
  port?: number;
  authToken?: string;
  rateLimit?: number; // requests per minute per IP, 0 = unlimited
}

export async function createAPIServer(
  workspace: string,
  engine: TaskEngine,
  memoryProviders: MemoryProvider[],
  hostOrConfig: string | APIServerConfig = "0.0.0.0",
  portArg = 8420,
) {
  // Backward-compatible: accept (host, port) or config object
  const cfg: APIServerConfig = typeof hostOrConfig === "string"
    ? { host: hostOrConfig, port: portArg }
    : hostOrConfig;

  const host = cfg.host || "0.0.0.0";
  const port = cfg.port || 8420;
  const authToken = cfg.authToken || "";
  const rateLimitPerMin = cfg.rateLimit ?? 0;

  const app = Fastify({ logger: false });

  // ── Bearer token auth ───────────────────────────────────────

  if (authToken) {
    app.addHook("onRequest", async (req, reply) => {
      // Skip auth for health check (allows monitoring probes)
      if (req.url === "/health") return;

      const header = req.headers.authorization || "";
      if (header !== `Bearer ${authToken}`) {
        reply.status(401).send({ error: "Unauthorized" });
      }
    });
    console.log("[api] Bearer token auth enabled");
  }

  // ── Rate limiting (sliding window per IP) ───────────────────

  if (rateLimitPerMin > 0) {
    const windows = new Map<string, number[]>();
    const WINDOW_MS = 60_000;

    // Prune stale entries every 5 minutes
    setInterval(() => {
      const cutoff = Date.now() - WINDOW_MS;
      for (const [ip, timestamps] of windows) {
        const filtered = timestamps.filter(t => t > cutoff);
        if (filtered.length === 0) windows.delete(ip);
        else windows.set(ip, filtered);
      }
    }, 300_000).unref();

    app.addHook("onRequest", async (req, reply) => {
      const ip = req.ip;
      const now = Date.now();
      const cutoff = now - WINDOW_MS;

      let timestamps = windows.get(ip) || [];
      timestamps = timestamps.filter(t => t > cutoff);
      timestamps.push(now);
      windows.set(ip, timestamps);

      const remaining = Math.max(0, rateLimitPerMin - timestamps.length);
      reply.header("X-RateLimit-Limit", rateLimitPerMin);
      reply.header("X-RateLimit-Remaining", remaining);

      if (timestamps.length > rateLimitPerMin) {
        reply.status(429).send({ error: "Rate limit exceeded", retryAfterMs: WINDOW_MS });
      }
    });
    console.log(`[api] Rate limiting: ${rateLimitPerMin} req/min per IP`);
  }

  // ── Submit task ──────────────────────────────────────────────

  app.post("/tasks", async (req, reply) => {
    const body = req.body as Record<string, any>;

    // Sanitize input from external REST API
    const { data, warnings, rejected, reason } = sanitizeTask(body, "rest_api");
    if (rejected) {
      reply.status(400);
      return { error: reason };
    }
    if (warnings.length > 0) {
      console.warn(`[api] Task sanitization warnings: ${warnings.join("; ")}`);
    }

    const now = new Date().toISOString();
    const taskId = `task-${now.slice(0, 19).replace(/[T:]/g, "").replace(/-/g, "")}-${uuidv4().slice(0, 6)}`;

    const taskData = {
      id: taskId,
      template: data.template || "ralph-loop",
      prompt: data.prompt || "",
      project: data.project || "",
      model: data.model || "sonnet",
      priority: data.priority || "normal",
      max_iterations: data.maxIterations || data.max_iterations || 5,
      params: data.params || {},
      created_at: now,
    };

    const taskFile = join(workspace, "tasks", "inbox", `${taskId}.yaml`);
    writeFileSync(taskFile, yaml.dump(taskData));

    return { id: taskId, status: "queued", file: taskFile, warnings: warnings.length > 0 ? warnings : undefined };
  });

  // ── List tasks ───────────────────────────────────────────────

  app.get("/tasks", async (req) => {
    const status = (req.query as any).status || "all";
    const dirs: Record<string, string> = { pending: "inbox", active: "active", completed: "completed", failed: "failed" };
    const scanDirs = status === "all" ? Object.values(dirs) : dirs[status] ? [dirs[status]] : [];

    const tasks: any[] = [];
    for (const d of scanDirs) {
      const dir = join(workspace, "tasks", d);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter(f => f.endsWith(".yaml")).sort().reverse()) {
        try {
          const data = yaml.load(readFileSync(join(dir, f), "utf-8")) as any;
          if (data && typeof data === "object") { data._dir = d; tasks.push(data); }
        } catch { /* skip */ }
      }
    }

    return { tasks, count: tasks.length };
  });

  // ── Get task ─────────────────────────────────────────────────

  app.get("/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    for (const d of ["inbox", "active", "completed", "failed"]) {
      const fp = join(workspace, "tasks", d, `${id}.yaml`);
      if (existsSync(fp)) {
        const data = yaml.load(readFileSync(fp, "utf-8")) as any;
        data._dir = d;
        return data;
      }
    }
    reply.status(404);
    return { error: `Task ${id} not found` };
  });

  // ── Cancel task ──────────────────────────────────────────────

  app.delete("/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    for (const d of ["inbox", "active"]) {
      const fp = join(workspace, "tasks", d, `${id}.yaml`);
      if (existsSync(fp)) {
        const data = yaml.load(readFileSync(fp, "utf-8")) as any;
        data.status = "cancelled";
        data.completed_at = new Date().toISOString();
        writeFileSync(join(workspace, "tasks", "failed", `${id}.yaml`), yaml.dump(data));
        unlinkSync(fp);
        return { id, status: "cancelled" };
      }
    }
    reply.status(404);
    return { error: `Task ${id} not found` };
  });

  // ── Memory search ────────────────────────────────────────────

  app.post("/memory/search", async (req) => {
    const { query, limit = 5 } = req.body as { query: string; limit?: number };
    const results: any[] = [];

    for (const p of memoryProviders) {
      try {
        const hits = await p.search(query, limit);
        for (const h of hits) {
          results.push({ content: h.content, score: h.score, source: h.source, provider: p.name });
        }
      } catch (e: any) {
        results.push({ error: e.message, provider: p.name });
      }
    }

    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    return { results: results.slice(0, limit), query };
  });

  // ── Health ───────────────────────────────────────────────────

  app.get("/health", async () => {
    let ccOk = false;
    try {
      const { execSync } = await import("node:child_process");
      execSync("claude --version", { encoding: "utf-8", timeout: 5000 });
      ccOk = true;
    } catch { /* */ }

    let ollamaOk = false;
    try {
      const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
      ollamaOk = res.ok;
    } catch { /* */ }

    return { status: "ok", claudeCode: ccOk, ollama: ollamaOk, workspace };
  });

  // ── Full status ──────────────────────────────────────────────

  app.get("/status", async () => {
    const queue: Record<string, number> = {};
    for (const d of ["inbox", "active", "completed", "failed"]) {
      const dir = join(workspace, "tasks", d);
      queue[d] = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".yaml")).length : 0;
    }

    const directives: Record<string, boolean> = {};
    for (const f of ["SOUL.md", "USER.md", "MEMORY.md", "CONVENTIONS.md"]) {
      directives[f] = existsSync(join(workspace, "directives", f));
    }

    return { queue, directives, memoryProviders: memoryProviders.map(p => p.name) };
  });

  // ── Start ────────────────────────────────────────────────────

  await app.listen({ host, port });
  console.log(`[api] Server listening at http://${host}:${port}`);
  return app;
}
