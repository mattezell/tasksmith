/**
 * TaskSmith MCP Server — Model Context Protocol interface.
 *
 * Exposes TaskSmith's core capabilities as MCP tools, allowing any MCP client
 * (Claude Code, Cursor, VS Code + Copilot, etc.) to submit tasks, query status,
 * search memory, and manage the task queue.
 *
 * Transport: stdio (MCP clients launch this as a subprocess).
 *
 * Usage:
 *   tasksmith mcp                   # start MCP server on stdio
 *   tasksmith mcp --dir <workspace> # explicit workspace
 *
 * MCP client config (e.g. claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "tasksmith": {
 *         "command": "tasksmith",
 *         "args": ["mcp"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";
import yaml from "js-yaml";
import {
  resolveWorkspace, loadConfig, scaffoldWorkspace, isTaskFile, listTemplates,
} from "./config.js";
import { sanitizeTask } from "./sanitize.js";
import type { TaskSmithConfig } from "./types.js";
import { MarkdownMemoryProvider, JSONLMemoryProvider } from "./providers/memory/providers.js";
import type { MemoryProvider } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

/**
 * Create and start the TaskSmith MCP server.
 *
 * @param workspaceOverride  Explicit workspace directory (from --dir flag)
 */
export async function startMCPServer(workspaceOverride?: string): Promise<void> {
  const workspace = resolveWorkspace(workspaceOverride);
  const config = loadConfig(workspace);
  scaffoldWorkspace(workspace);

  // Initialize memory providers for search
  const memoryProviders: MemoryProvider[] = [];
  try {
    const hotCfg = config.memory.hot.config;
    memoryProviders.push(new MarkdownMemoryProvider(hotCfg, workspace));

    for (const entry of config.memory.warm) {
      if (entry.provider === "jsonl_logs") {
        memoryProviders.push(new JSONLMemoryProvider(entry.config, workspace));
      }
    }

    for (const p of memoryProviders) await p.initialize();
  } catch {
    // Memory providers are optional — MCP server works without them
  }

  const server = new McpServer({
    name: "tasksmith",
    version: pkg.version,
  });

  // ── Tool: submit_task ──────────────────────────────────────────────

  server.tool(
    "submit_task",
    "Submit a new task to TaskSmith. The task is placed in the inbox and picked up by the engine. Returns the task ID for tracking.",
    {
      prompt: z.string().describe("What the task should accomplish"),
      template: z.string().optional().describe("Template to use: ralph-loop, bug-hunt, code-review, research, project-init, doc-gen, heartbeat"),
      project: z.string().optional().describe("Project name (must match a project in the workspace)"),
      model: z.string().optional().describe("Model to use: auto (smart routing), sonnet, opus, haiku. Default: auto"),
      priority: z.string().optional().describe("Priority: low, normal, high, urgent"),
      max_iterations: z.number().optional().describe("Max Ralph Loop iterations (1-20, default 5)"),
      validation_command: z.string().optional().describe("Command to validate each iteration (e.g. 'npm test')"),
      params: z.record(z.string(), z.unknown()).optional().describe("Additional task parameters"),
    },
    async (args) => {
      const taskData: Record<string, any> = {
        prompt: args.prompt,
        template: args.template || "ralph-loop",
        project: args.project || "",
        model: args.model || "sonnet",
        priority: args.priority || "normal",
        max_iterations: args.max_iterations || 5,
        params: { ...args.params },
      };

      if (args.validation_command) {
        taskData.params.validation_command = args.validation_command;
      }

      // Sanitize (MCP is an external source)
      const { data, warnings, rejected, reason } = sanitizeTask(taskData, "mcp");
      if (rejected) {
        return { content: [{ type: "text" as const, text: `Task rejected: ${reason}` }], isError: true };
      }

      const now = new Date().toISOString();
      const taskId = `task-${now.slice(0, 19).replace(/[T:]/g, "").replace(/-/g, "")}-${uuidv4().slice(0, 6)}`;

      const task = {
        id: taskId,
        ...data,
        created_at: now,
      };

      const taskFile = join(workspace, "tasks", "inbox", `${taskId}.yaml`);
      writeFileSync(taskFile, yaml.dump(task));

      let response = `Task submitted: ${taskId}`;
      if (warnings.length > 0) {
        response += `\nWarnings: ${warnings.join("; ")}`;
      }

      return { content: [{ type: "text" as const, text: response }] };
    },
  );

  // ── Tool: get_task_status ──────────────────────────────────────────

  server.tool(
    "get_task_status",
    "Get the current status and details of a specific task by its ID.",
    {
      task_id: z.string().describe("The task ID (e.g. task-20260222-001234-abc123)"),
    },
    async ({ task_id }) => {
      for (const dir of ["inbox", "active", "completed", "failed"]) {
        const fp = join(workspace, "tasks", dir, `${task_id}.yaml`);
        if (existsSync(fp)) {
          const data = yaml.load(readFileSync(fp, "utf-8")) as any;
          const statusMap: Record<string, string> = {
            inbox: "pending",
            active: "active",
            completed: "completed",
            failed: "failed",
          };
          data._status = statusMap[dir] || dir;
          return { content: [{ type: "text" as const, text: yaml.dump(data, { lineWidth: 120 }) }] };
        }
      }
      return { content: [{ type: "text" as const, text: `Task ${task_id} not found.` }], isError: true };
    },
  );

  // ── Tool: list_tasks ───────────────────────────────────────────────

  server.tool(
    "list_tasks",
    "List tasks by status. Returns a summary of tasks in the specified queue.",
    {
      status: z.enum(["all", "pending", "active", "completed", "failed"]).optional()
        .describe("Filter by status (default: all)"),
      limit: z.number().optional().describe("Max number of tasks to return (default: 20)"),
    },
    async ({ status = "all", limit = 20 }) => {
      const dirs: Record<string, string> = {
        pending: "inbox", active: "active",
        completed: "completed", failed: "failed",
      };
      const scanDirs = status === "all" ? Object.entries(dirs) : [[status, dirs[status!]]];

      const tasks: string[] = [];
      for (const [label, dir] of scanDirs) {
        if (!dir) continue;
        const dirPath = join(workspace, "tasks", dir);
        if (!existsSync(dirPath)) continue;

        const files = readdirSync(dirPath)
          .filter(f => isTaskFile(f))
          .sort()
          .reverse()
          .slice(0, limit);

        for (const f of files) {
          try {
            const data = yaml.load(readFileSync(join(dirPath, f), "utf-8")) as any;
            const id = data.id || f.replace(/\.(yaml|yml|json)$/, "");
            const template = data.template || "?";
            const project = data.project || "-";
            const prompt = (data.prompt || "").slice(0, 80);
            tasks.push(`[${label}] ${id} | ${template} | ${project} | ${prompt}`);
          } catch { /* skip */ }
        }
      }

      if (tasks.length === 0) {
        return { content: [{ type: "text" as const, text: "No tasks found." }] };
      }

      return { content: [{ type: "text" as const, text: tasks.join("\n") }] };
    },
  );

  // ── Tool: cancel_task ──────────────────────────────────────────────

  server.tool(
    "cancel_task",
    "Cancel a pending or active task. Moves it to the failed directory with cancelled status.",
    {
      task_id: z.string().describe("The task ID to cancel"),
    },
    async ({ task_id }) => {
      for (const dir of ["inbox", "active"]) {
        const fp = join(workspace, "tasks", dir, `${task_id}.yaml`);
        if (existsSync(fp)) {
          const data = yaml.load(readFileSync(fp, "utf-8")) as any;
          data.status = "cancelled";
          data.completed_at = new Date().toISOString();
          writeFileSync(join(workspace, "tasks", "failed", `${task_id}.yaml`), yaml.dump(data));
          unlinkSync(fp);
          return { content: [{ type: "text" as const, text: `Task ${task_id} cancelled.` }] };
        }
      }
      return { content: [{ type: "text" as const, text: `Task ${task_id} not found in inbox or active.` }], isError: true };
    },
  );

  // ── Tool: search_memory ────────────────────────────────────────────

  server.tool(
    "search_memory",
    "Search TaskSmith's memory for past task results, decisions, errors, and learnings.",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Max results (default: 5)"),
    },
    async ({ query, limit = 5 }) => {
      if (memoryProviders.length === 0) {
        return { content: [{ type: "text" as const, text: "No memory providers available." }], isError: true };
      }

      const results: string[] = [];
      for (const p of memoryProviders) {
        try {
          const hits = await p.search(query, limit);
          for (const h of hits) {
            results.push(`[${p.name}] (score: ${h.score.toFixed(2)}) ${h.content}`);
          }
        } catch (e: any) {
          results.push(`[${p.name}] Error: ${e.message}`);
        }
      }

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No memory results found." }] };
      }

      return { content: [{ type: "text" as const, text: results.slice(0, limit).join("\n\n") }] };
    },
  );

  // ── Tool: list_templates ───────────────────────────────────────────

  server.tool(
    "list_templates",
    "List all available task templates with their sources.",
    {},
    async () => {
      const templates = listTemplates(workspace, config);
      if (templates.length === 0) {
        return { content: [{ type: "text" as const, text: "No templates found." }] };
      }

      const lines = templates.map(t => `${t.name} (${t.source})`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── Tool: list_projects ────────────────────────────────────────────

  server.tool(
    "list_projects",
    "List all configured projects in the workspace.",
    {},
    async () => {
      const projectsDir = join(workspace, "projects");
      if (!existsSync(projectsDir)) {
        return { content: [{ type: "text" as const, text: "No projects directory found." }] };
      }

      try {
        const entries = readdirSync(projectsDir, { withFileTypes: true });
        const projects = entries
          .filter(e => e.isDirectory() || e.isSymbolicLink())
          .map(e => e.name);

        if (projects.length === 0) {
          return { content: [{ type: "text" as const, text: "No projects found." }] };
        }

        return { content: [{ type: "text" as const, text: projects.join("\n") }] };
      } catch {
        return { content: [{ type: "text" as const, text: "Could not read projects directory." }], isError: true };
      }
    },
  );

  // ── Tool: queue_status ─────────────────────────────────────────────

  server.tool(
    "queue_status",
    "Get a summary of the task queue: counts by status, memory providers, and system info.",
    {},
    async () => {
      const queue: Record<string, number> = {};
      for (const dir of ["inbox", "active", "completed", "failed"]) {
        const dirPath = join(workspace, "tasks", dir);
        queue[dir] = existsSync(dirPath)
          ? readdirSync(dirPath).filter(f => isTaskFile(f)).length
          : 0;
      }

      const directives: string[] = [];
      for (const f of ["SOUL.md", "USER.md", "MEMORY.md", "CONVENTIONS.md"]) {
        if (existsSync(join(workspace, "directives", f))) directives.push(f);
      }

      const lines = [
        `TaskSmith v${pkg.version}`,
        `Workspace: ${workspace}`,
        "",
        "Queue:",
        `  Pending:   ${queue.inbox}`,
        `  Active:    ${queue.active}`,
        `  Completed: ${queue.completed}`,
        `  Failed:    ${queue.failed}`,
        "",
        `Directives: ${directives.join(", ") || "none"}`,
        `Memory providers: ${memoryProviders.map(p => p.name).join(", ") || "none"}`,
      ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── Resource: system status ────────────────────────────────────────

  server.resource(
    "system-status",
    "tasksmith://status",
    async (uri) => {
      const queue: Record<string, number> = {};
      for (const dir of ["inbox", "active", "completed", "failed"]) {
        const dirPath = join(workspace, "tasks", dir);
        queue[dir] = existsSync(dirPath)
          ? readdirSync(dirPath).filter(f => isTaskFile(f)).length
          : 0;
      }

      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ version: pkg.version, workspace, queue }, null, 2),
          mimeType: "application/json",
        }],
      };
    },
  );

  // ── Resource: MEMORY.md ────────────────────────────────────────────

  server.resource(
    "memory",
    "tasksmith://memory",
    async (uri) => {
      const memFile = join(workspace, "directives", "MEMORY.md");
      const content = existsSync(memFile)
        ? readFileSync(memFile, "utf-8")
        : "No memory file found.";

      return {
        contents: [{
          uri: uri.href,
          text: content,
          mimeType: "text/markdown",
        }],
      };
    },
  );

  // ── Connect via stdio ──────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
