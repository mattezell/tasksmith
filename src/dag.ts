/**
 * TaskSmith DAG Manager — dependency workflows.
 *
 * A DAG (Directed Acyclic Graph) chains tasks with explicit dependencies.
 * Task B starts only after Task A completes successfully. Failure propagates
 * downstream — if A fails, B and all its transitive dependents are cancelled.
 *
 * DAG file format (YAML):
 *
 *   dag_id: deploy-pipeline
 *   tasks:
 *     - id: build
 *       template: ralph-loop
 *       prompt: "Build the project"
 *       params:
 *         validation_command: "npm run build"
 *
 *     - id: test
 *       depends_on: [build]
 *       template: ralph-loop
 *       prompt: "Run tests"
 *       params:
 *         validation_command: "npm test"
 *
 *     - id: deploy
 *       depends_on: [test]
 *       template: ralph-loop
 *       prompt: "Deploy to staging"
 *
 * Submit via CLI:   tasksmith submit -f pipeline.yaml
 * Submit via MCP:   submit_task with DAG YAML as prompt
 * Submit via inbox: Drop the file in tasks/inbox/
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { Task } from "./types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface DAGNode {
  taskId: string;
  dependsOn: string[];
  status: "pending" | "active" | "completed" | "failed" | "cancelled";
}

export interface DAGState {
  dagId: string;
  nodes: DAGNode[];
  createdAt: string;
  completedAt?: string;
  status: "active" | "completed" | "failed";
}

// =============================================================================
// DAG MANAGER
// =============================================================================

export class DAGManager {
  /** Active DAGs indexed by dagId. */
  private dags = new Map<string, DAGState>();

  private workspace: string;
  private log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

  constructor(
    workspace: string,
    log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
  ) {
    this.workspace = workspace;
    this.log = log || {
      info: (m: string) => console.log(`[dag] ${m}`),
      warn: (m: string) => console.log(`[dag] WARN: ${m}`),
      error: (m: string) => console.log(`[dag] ERROR: ${m}`),
    };

    // Restore any persisted DAG state from disk
    this.restore();
  }

  // ── DAG Detection ──────────────────────────────────────────────────

  /**
   * Check if parsed task data represents a DAG (has a `tasks` array).
   */
  static isDAG(data: Record<string, any>): boolean {
    return Array.isArray(data.tasks) && data.tasks.length > 0;
  }

  // ── DAG Registration ───────────────────────────────────────────────

  /**
   * Register a DAG from parsed file data. Validates the graph structure
   * (no cycles, all dependencies exist) and returns the list of tasks
   * with their dag metadata set.
   *
   * @returns Array of Task-like objects with dagId and dependsOn set,
   *          or null if the DAG is invalid.
   */
  registerDAG(data: Record<string, any>): { dagId: string; tasks: Record<string, any>[] } | null {
    const dagId = data.dag_id || data.dagId || `dag-${Date.now()}`;
    const rawTasks = data.tasks as Record<string, any>[];

    if (!rawTasks || rawTasks.length === 0) {
      this.log.error("DAG has no tasks");
      return null;
    }

    // Validate: all task IDs are unique
    const ids = new Set<string>();
    for (const t of rawTasks) {
      if (!t.id) {
        this.log.error("DAG task missing 'id' field");
        return null;
      }
      if (ids.has(t.id)) {
        this.log.error(`DAG has duplicate task ID: ${t.id}`);
        return null;
      }
      ids.add(t.id);
    }

    // Validate: all dependencies reference existing tasks
    for (const t of rawTasks) {
      const deps = t.depends_on || t.dependsOn || [];
      for (const dep of deps) {
        if (!ids.has(dep)) {
          this.log.error(`DAG task '${t.id}' depends on unknown task '${dep}'`);
          return null;
        }
        if (dep === t.id) {
          this.log.error(`DAG task '${t.id}' depends on itself`);
          return null;
        }
      }
    }

    // Validate: no cycles (topological sort)
    if (this.hasCycle(rawTasks)) {
      this.log.error("DAG contains a cycle");
      return null;
    }

    // Inherit shared properties from DAG level (project, model, etc.)
    const shared: Record<string, any> = {};
    for (const key of ["project", "model", "priority", "notify"]) {
      if (data[key] != null) shared[key] = data[key];
    }

    // Build nodes and enrich tasks
    const nodes: DAGNode[] = [];
    const enrichedTasks: Record<string, any>[] = [];

    for (const t of rawTasks) {
      const deps: string[] = t.depends_on || t.dependsOn || [];
      nodes.push({
        taskId: t.id,
        dependsOn: deps,
        status: "pending",
      });

      enrichedTasks.push({
        ...shared,
        ...t,
        dag_id: dagId,
        depends_on: deps,
      });
    }

    // Register the DAG
    const state: DAGState = {
      dagId,
      nodes,
      createdAt: new Date().toISOString(),
      status: "active",
    };
    this.dags.set(dagId, state);
    this.persist(state);

    this.log.info(`DAG '${dagId}' registered: ${nodes.length} tasks, ${nodes.filter(n => n.dependsOn.length === 0).length} root(s)`);

    return { dagId, tasks: enrichedTasks };
  }

  // ── Dependency Resolution ──────────────────────────────────────────

  /**
   * Get tasks that are ready to run (all dependencies completed).
   * Returns task IDs that should be submitted to the pool.
   */
  getReadyTasks(dagId: string): string[] {
    const dag = this.dags.get(dagId);
    if (!dag || dag.status !== "active") return [];

    const ready: string[] = [];
    for (const node of dag.nodes) {
      if (node.status !== "pending") continue;

      const allDepsComplete = node.dependsOn.every(depId => {
        const depNode = dag.nodes.find(n => n.taskId === depId);
        return depNode?.status === "completed";
      });

      if (allDepsComplete) {
        ready.push(node.taskId);
      }
    }

    return ready;
  }

  /**
   * Mark a task as active (submitted to pool).
   */
  markActive(dagId: string, taskId: string): void {
    const dag = this.dags.get(dagId);
    if (!dag) return;

    const node = dag.nodes.find(n => n.taskId === taskId);
    if (node) {
      node.status = "active";
      this.persist(dag);
    }
  }

  /**
   * Report task completion. Returns newly unblocked task IDs.
   */
  reportCompletion(dagId: string, taskId: string): string[] {
    const dag = this.dags.get(dagId);
    if (!dag) return [];

    const node = dag.nodes.find(n => n.taskId === taskId);
    if (node) {
      node.status = "completed";
      this.log.info(`DAG '${dagId}': task '${taskId}' completed`);
    }

    // Check if DAG is fully complete
    if (dag.nodes.every(n => n.status === "completed")) {
      dag.status = "completed";
      dag.completedAt = new Date().toISOString();
      this.log.info(`DAG '${dagId}' completed successfully`);
    }

    this.persist(dag);

    // Return newly ready tasks
    return this.getReadyTasks(dagId);
  }

  /**
   * Report task failure. Cancels all downstream dependents.
   * Returns task IDs that were cancelled.
   */
  reportFailure(dagId: string, taskId: string): string[] {
    const dag = this.dags.get(dagId);
    if (!dag) return [];

    const node = dag.nodes.find(n => n.taskId === taskId);
    if (node) {
      node.status = "failed";
      this.log.warn(`DAG '${dagId}': task '${taskId}' failed`);
    }

    // Cancel all transitive dependents
    const cancelled = this.cancelDownstream(dag, taskId);
    if (cancelled.length > 0) {
      this.log.warn(`DAG '${dagId}': cancelled ${cancelled.length} downstream task(s): ${cancelled.join(", ")}`);
    }

    // Mark DAG as failed
    dag.status = "failed";
    dag.completedAt = new Date().toISOString();

    this.persist(dag);
    return cancelled;
  }

  /**
   * Check if a task is blocked by unfinished dependencies.
   */
  isBlocked(dagId: string, taskId: string): boolean {
    const dag = this.dags.get(dagId);
    if (!dag) return false;

    const node = dag.nodes.find(n => n.taskId === taskId);
    if (!node) return false;

    return node.dependsOn.some(depId => {
      const dep = dag.nodes.find(n => n.taskId === depId);
      return dep?.status !== "completed";
    });
  }

  /**
   * Get a text summary of a DAG's current state.
   */
  getStatus(dagId: string): string | null {
    const dag = this.dags.get(dagId);
    if (!dag) return null;

    const lines = [`DAG: ${dagId} (${dag.status})`, ""];
    for (const node of dag.nodes) {
      const deps = node.dependsOn.length > 0 ? ` ← [${node.dependsOn.join(", ")}]` : "";
      const icon = { pending: "○", active: "◉", completed: "✓", failed: "✗", cancelled: "⊘" }[node.status];
      lines.push(`  ${icon} ${node.taskId} (${node.status})${deps}`);
    }

    return lines.join("\n");
  }

  /**
   * List all tracked DAGs.
   */
  listDAGs(): DAGState[] {
    return Array.from(this.dags.values());
  }

  // ── Cycle Detection ────────────────────────────────────────────────

  private hasCycle(tasks: Record<string, any>[]): boolean {
    const visited = new Set<string>();
    const stack = new Set<string>();

    const depsMap = new Map<string, string[]>();
    for (const t of tasks) {
      depsMap.set(t.id, t.depends_on || t.dependsOn || []);
    }

    const visit = (id: string): boolean => {
      if (stack.has(id)) return true; // cycle
      if (visited.has(id)) return false;

      visited.add(id);
      stack.add(id);

      for (const dep of depsMap.get(id) || []) {
        if (visit(dep)) return true;
      }

      stack.delete(id);
      return false;
    };

    for (const t of tasks) {
      if (visit(t.id)) return true;
    }

    return false;
  }

  // ── Downstream Cancellation ────────────────────────────────────────

  private cancelDownstream(dag: DAGState, failedTaskId: string): string[] {
    const cancelled: string[] = [];
    const toCancel = new Set<string>();

    // Find all transitive dependents
    const findDependents = (taskId: string) => {
      for (const node of dag.nodes) {
        if (node.dependsOn.includes(taskId) && !toCancel.has(node.taskId)) {
          if (node.status === "pending") {
            toCancel.add(node.taskId);
            findDependents(node.taskId); // transitive
          }
        }
      }
    };

    findDependents(failedTaskId);

    for (const taskId of toCancel) {
      const node = dag.nodes.find(n => n.taskId === taskId);
      if (node) {
        node.status = "cancelled";
        cancelled.push(taskId);
      }
    }

    return cancelled;
  }

  // ── Persistence ────────────────────────────────────────────────────

  private dagDir(): string {
    return join(this.workspace, "tasks", "dags");
  }

  private persist(dag: DAGState): void {
    const dir = this.dagDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${dag.dagId}.yaml`), yaml.dump(dag, { lineWidth: 120 }));
  }

  private restore(): void {
    const dir = this.dagDir();
    if (!existsSync(dir)) return;

    try {
      const { readdirSync } = require("node:fs");
      const files = readdirSync(dir).filter((f: string) => f.endsWith(".yaml"));
      for (const f of files) {
        try {
          const data = yaml.load(readFileSync(join(dir, f), "utf-8")) as DAGState;
          if (data?.dagId && data.status === "active") {
            this.dags.set(data.dagId, data);
            this.log.info(`Restored active DAG: ${data.dagId}`);
          }
        } catch { /* skip corrupt files */ }
      }
    } catch { /* dir not readable */ }
  }
}
