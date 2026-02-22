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

export async function createAPIServer(
  workspace: string,
  engine: TaskEngine,
  memoryProviders: MemoryProvider[],
  host = "0.0.0.0",
  port = 8420,
) {
  const app = Fastify({ logger: false });

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
