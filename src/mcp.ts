/**
 * TaskSmith MCP Server — Model Context Protocol interface.
 *
 * Exposes TaskSmith's core capabilities as MCP tools, allowing any MCP client
 * (Claude Code, Cursor, VS Code + Copilot, etc.) to submit tasks, query status,
 * search memory, and manage the task queue.
 *
 * Transport: stdio (MCP clients launch this as a subprocess).
 *
 * Tools (13):
 *   submit_task, get_task_status, list_tasks, cancel_task, retry_task,
 *   search_memory, store_memory, list_projects,
 *   queue_status, health_check, submit_dag, dag_status, list_dags
 *
 * Resources (4):
 *   tasksmith://status, tasksmith://memory,
 *   tasksmith://directives/{name}, tasksmith://projects/{name}
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
import { execSync } from "node:child_process";
import { v4 as uuidv4 } from "uuid";
import yaml from "js-yaml";
import {
  resolveWorkspace, loadConfig, scaffoldWorkspace, isTaskFile,
} from "./config.js";
import { sanitizeTask } from "./sanitize.js";
import type { TaskSmithConfig, MemoryEntry } from "./types.js";
import { MarkdownMemoryProvider, JSONLMemoryProvider } from "./providers/memory/providers.js";
import type { MemoryProvider } from "./types.js";
import { DAGManager } from "./dag.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

/** Options for MCP server — allows the coordinator to inject shared instances. */
export interface MCPServerOptions {
  workspaceOverride?: string;
  dagManager?: DAGManager;
  memoryProviders?: MemoryProvider[];
}

/**
 * Create and start the TaskSmith MCP server.
 *
 * @param workspaceOrOptions  Explicit workspace directory string (backward compat)
 *                            or options object with shared instances.
 */
export async function startMCPServer(workspaceOrOptions?: string | MCPServerOptions): Promise<void> {
  // Backward-compatible: accept string or options object
  const opts: MCPServerOptions = typeof workspaceOrOptions === "string"
    ? { workspaceOverride: workspaceOrOptions }
    : workspaceOrOptions || {};

  const workspace = resolveWorkspace(opts.workspaceOverride);
  const config = loadConfig(workspace);
  scaffoldWorkspace(workspace);

  // Initialize memory providers — use injected ones or create fresh
  let memoryProviders: MemoryProvider[] = opts.memoryProviders || [];
  if (memoryProviders.length === 0) {
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
  }

  // Use injected DAGManager or create one (restores persisted state from disk)
  const dagManager = opts.dagManager || new DAGManager(workspace);

  const server = new McpServer({
    name: "tasksmith",
    version: pkg.version,
  });

  // ── Tool: submit_task ──────────────────────────────────────────────

  server.tool(
    "submit_task",
    "Submit a new task to TaskSmith. The task is placed in the inbox and picked up by the engine. Returns the task ID for tracking. Example: submit_task({ prompt: 'Add input validation to the signup form', template: 'ralph-loop', project: 'my-app', validation_command: 'npm test' })",
    {
      prompt: z.string().describe("What the task should accomplish"),
      template: z.string().optional().describe("Template to use: ralph-loop, bug-hunt, code-review, research, project-init, doc-gen, heartbeat"),
      project: z.string().optional().describe("Project name (must match a project in the workspace)"),
      model: z.string().optional().describe("Model to use: auto (smart routing — recommended), sonnet, opus, haiku. Default: auto"),
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
        model: args.model || "auto",
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
    "Get the current status and details of a specific task by its ID. Returns the full task YAML including prompt, result, error, iterations, model, and timing.",
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
    "List tasks by status. Returns structured YAML for each task including id, template, project, model, prompt (truncated), and timing fields.",
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

      const tasks: Record<string, any>[] = [];
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
            tasks.push({
              id: data.id || f.replace(/\.(yaml|yml|json)$/, ""),
              status: label,
              template: data.template || "?",
              project: data.project || "",
              model: data.model || "?",
              prompt: (data.prompt || "").slice(0, 120),
              created_at: data.created_at || data.createdAt || "",
              iterations: data.iterations || 0,
              result: data.result ? String(data.result).slice(0, 200) : "",
              error: data.error ? String(data.error).slice(0, 200) : "",
            });
          } catch { /* skip */ }
        }
      }

      if (tasks.length === 0) {
        return { content: [{ type: "text" as const, text: "No tasks found." }] };
      }

      return { content: [{ type: "text" as const, text: yaml.dump(tasks.slice(0, limit), { lineWidth: 120 }) }] };
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

  // ── Tool: retry_task ───────────────────────────────────────────────

  server.tool(
    "retry_task",
    "Retry a failed task by copying it back to the inbox with a new ID. The original task is preserved in the failed directory for reference.",
    {
      task_id: z.string().describe("The failed task ID to retry"),
      model: z.string().optional().describe("Override model for the retry (default: keep original)"),
      max_iterations: z.number().optional().describe("Override max iterations for the retry"),
    },
    async ({ task_id, model, max_iterations }) => {
      const fp = join(workspace, "tasks", "failed", `${task_id}.yaml`);
      if (!existsSync(fp)) {
        return { content: [{ type: "text" as const, text: `Task ${task_id} not found in failed queue.` }], isError: true };
      }

      const data = yaml.load(readFileSync(fp, "utf-8")) as any;

      // Strip completion fields for the new attempt
      delete data.status;
      delete data.completed_at;
      delete data.completedAt;
      delete data.started_at;
      delete data.startedAt;
      delete data.error;
      delete data.result;
      delete data.iterations;
      delete data._status;

      // Apply overrides
      if (model) data.model = model;
      if (max_iterations) data.max_iterations = max_iterations;

      const now = new Date().toISOString();
      const newId = `task-${now.slice(0, 19).replace(/[T:]/g, "").replace(/-/g, "")}-${uuidv4().slice(0, 6)}`;
      data.id = newId;
      data.created_at = now;
      data.retry_of = task_id;

      const taskFile = join(workspace, "tasks", "inbox", `${newId}.yaml`);
      writeFileSync(taskFile, yaml.dump(data));

      return { content: [{ type: "text" as const, text: `Retry submitted: ${newId} (retry of ${task_id})` }] };
    },
  );

  // ── Tool: search_memory ────────────────────────────────────────────

  server.tool(
    "search_memory",
    "Search TaskSmith's memory for past task results, decisions, errors, and learnings. Searches across hot (MEMORY.md) and warm (JSONL logs) memory providers.",
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

  // ── Tool: store_memory ─────────────────────────────────────────────

  server.tool(
    "store_memory",
    "Store a fact, decision, or learning in TaskSmith's memory. Useful for recording preferences, project decisions, debugging insights, or anything that should persist across sessions.",
    {
      content: z.string().describe("The content to remember"),
      category: z.enum(["general", "decision", "preference", "fact", "error"]).optional()
        .describe("Category (default: general)"),
      importance: z.number().optional()
        .describe("Importance from 0.0 to 1.0 (default: 0.7). Higher values are retained longer."),
    },
    async ({ content: memContent, category = "general", importance = 0.7 }) => {
      if (memoryProviders.length === 0) {
        return { content: [{ type: "text" as const, text: "No memory providers available." }], isError: true };
      }

      const entry: MemoryEntry = {
        content: memContent,
        source: "mcp",
        category,
        importance: Math.max(0, Math.min(1, importance)),
        timestamp: new Date(),
      };

      const stored: string[] = [];
      for (const p of memoryProviders) {
        try {
          await p.store(entry);
          stored.push(p.name);
        } catch (e: any) {
          stored.push(`${p.name} (error: ${e.message})`);
        }
      }

      return { content: [{ type: "text" as const, text: `Stored in: ${stored.join(", ")}` }] };
    },
  );

  // ── Tool: list_projects ────────────────────────────────────────────

  server.tool(
    "list_projects",
    "List all configured projects in the workspace. Use project names when submitting tasks.",
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

  // ── Tool: health_check ─────────────────────────────────────────────

  server.tool(
    "health_check",
    "Check system health: Claude Code CLI availability, workspace status, and optional Ollama connectivity. Call this to verify the system is ready to execute tasks.",
    {},
    async () => {
      const checks: Record<string, string> = {};

      // Claude Code CLI
      try {
        const version = execSync("claude --version", { encoding: "utf-8", timeout: 5000 }).trim();
        checks.claude_code = `ok (${version})`;
      } catch {
        checks.claude_code = "not found";
      }

      // Workspace
      checks.workspace = existsSync(workspace) ? "ok" : "missing";

      // Inbox writability
      const inboxDir = join(workspace, "tasks", "inbox");
      try {
        const testFile = join(inboxDir, `.health-${Date.now()}`);
        writeFileSync(testFile, "");
        unlinkSync(testFile);
        checks.inbox = "writable";
      } catch {
        checks.inbox = "not writable";
      }

      // Memory providers
      checks.memory = memoryProviders.length > 0
        ? `${memoryProviders.length} provider(s): ${memoryProviders.map(p => p.name).join(", ")}`
        : "none";

      // Ollama (optional)
      try {
        const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
        checks.ollama = res.ok ? "ok" : "error";
      } catch {
        checks.ollama = "not running";
      }

      const lines = Object.entries(checks).map(([k, v]) => `${k}: ${v}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── Tool: submit_dag ────────────────────────────────────────────────

  server.tool(
    "submit_dag",
    "Submit a DAG (dependency workflow) — multiple tasks with dependencies. Each task runs only after its dependencies complete. Failure propagates downstream. Example: submit_dag({ tasks: [{ id: 'build', prompt: 'Build project' }, { id: 'test', prompt: 'Run tests', depends_on: ['build'] }] })",
    {
      dag_id: z.string().optional().describe("DAG identifier (auto-generated if omitted)"),
      project: z.string().optional().describe("Default project for all tasks"),
      model: z.string().optional().describe("Default model for all tasks"),
      tasks: z.array(z.object({
        id: z.string().describe("Unique task ID within this DAG"),
        prompt: z.string().describe("What the task should accomplish"),
        template: z.string().optional().describe("Template (default: ralph-loop)"),
        depends_on: z.array(z.string()).optional().describe("IDs of tasks this depends on"),
        params: z.record(z.string(), z.unknown()).optional().describe("Task parameters"),
      })).describe("Tasks in the DAG"),
    },
    async (args) => {
      const data: Record<string, any> = {
        dag_id: args.dag_id,
        project: args.project,
        model: args.model,
        tasks: args.tasks,
      };

      const result = dagManager.registerDAG(data);
      if (!result) {
        return { content: [{ type: "text" as const, text: "DAG registration failed. Check for cycles, missing IDs, or duplicate task IDs." }], isError: true };
      }

      // Write individual tasks to inbox (the engine will pick them up)
      for (const task of result.tasks) {
        const { data: clean } = sanitizeTask(task, "mcp");
        const taskFile = join(workspace, "tasks", "inbox", `${task.id}.yaml`);
        writeFileSync(taskFile, yaml.dump({
          ...clean,
          dag_id: result.dagId,
          depends_on: task.depends_on || [],
          created_at: new Date().toISOString(),
        }));
      }

      return { content: [{ type: "text" as const, text: `DAG '${result.dagId}' submitted with ${result.tasks.length} tasks. Root tasks placed in inbox.` }] };
    },
  );

  // ── Tool: dag_status ───────────────────────────────────────────────

  server.tool(
    "dag_status",
    "Get the current status of a DAG (dependency workflow), showing each task's state and dependencies.",
    {
      dag_id: z.string().describe("The DAG identifier"),
    },
    async ({ dag_id }) => {
      const status = dagManager.getStatus(dag_id);
      if (!status) {
        return { content: [{ type: "text" as const, text: `DAG '${dag_id}' not found.` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: status }] };
    },
  );

  // ── Tool: list_dags ────────────────────────────────────────────────

  server.tool(
    "list_dags",
    "List all tracked DAGs and their completion status.",
    {},
    async () => {
      const dags = dagManager.listDAGs();
      if (dags.length === 0) {
        return { content: [{ type: "text" as const, text: "No DAGs found." }] };
      }

      const lines = dags.map(dag => {
        const completed = dag.nodes.filter(n => n.status === "completed").length;
        const total = dag.nodes.length;
        return `${dag.dagId} — ${completed}/${total} tasks — ${dag.status}`;
      });

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

  // ── Resources: directives (SOUL.md, USER.md, CONVENTIONS.md, etc.) ─

  const directiveFiles = ["SOUL.md", "USER.md", "CONVENTIONS.md", "GLOSSARY.md", "MEMORY.md"];
  for (const file of directiveFiles) {
    const name = file.replace(".md", "").toLowerCase();
    server.resource(
      `directive-${name}`,
      `tasksmith://directives/${name}`,
      async (uri) => {
        const fp = join(workspace, "directives", file);
        const content = existsSync(fp)
          ? readFileSync(fp, "utf-8")
          : `No ${file} found.`;

        return {
          contents: [{
            uri: uri.href,
            text: content,
            mimeType: "text/markdown",
          }],
        };
      },
    );
  }

  // ── Resources: projects ────────────────────────────────────────────

  const projectsDir = join(workspace, "projects");
  if (existsSync(projectsDir)) {
    try {
      const projectEntries = readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of projectEntries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const projectName = entry.name;

        server.resource(
          `project-${projectName}`,
          `tasksmith://projects/${projectName}`,
          async (uri) => {
            const pd = join(projectsDir, projectName);
            const parts: string[] = [`# Project: ${projectName}\n`];

            for (const [file, label] of [["CLAUDE.md", "Context"], ["TASKS.md", "Backlog"]] as const) {
              const fp = join(pd, file);
              if (existsSync(fp)) {
                parts.push(`## ${label} (${file})\n\n${readFileSync(fp, "utf-8")}`);
              }
            }

            return {
              contents: [{
                uri: uri.href,
                text: parts.join("\n\n"),
                mimeType: "text/markdown",
              }],
            };
          },
        );
      }
    } catch { /* skip unreadable projects dir */ }
  }

  // ── Connect via stdio ──────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
