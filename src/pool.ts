/**
 * TaskSmith Worker Pool
 *
 * Manages parallel task execution with configurable concurrency.
 * Optionally isolates each task in its own git worktree so parallel
 * tasks can't clobber each other's changes.
 *
 * Config in tasksmith.yaml:
 *
 *   engine:
 *     concurrency: 3                # max parallel tasks (default: 1)
 *     worktree:
 *       enabled: true               # isolate tasks in git worktrees
 *       strategy: "pr"              # "pr" | "auto-merge" | "branch-only"
 *       baseBranch: "main"          # branch to create worktrees from
 *       cleanupOnSuccess: true      # remove worktree after merge/PR
 *       cleanupOnFailure: true      # remove worktree on failure
 *       prLabels:                   # labels added to PRs
 *         - "tasksmith"
 *         - "automated"
 *
 * Task-level overrides (in params):
 *   params:
 *     worktree: false               # disable worktree for this task
 *     worktree_strategy: "auto-merge"
 *     worktree_branch: "feat/custom-name"
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./types.js";

// ── Config Types ────────────────────────────────────────────────────

export type WorktreeStrategy = "pr" | "auto-merge" | "branch-only" | "local";

export interface WorktreeConfig {
  enabled: boolean;
  strategy: WorktreeStrategy;
  baseBranch: string;
  cleanupOnSuccess: boolean;
  cleanupOnFailure: boolean;
  prLabels: string[];
}

export interface PoolConfig {
  concurrency: number;
  worktree: WorktreeConfig;
}

export const POOL_DEFAULTS: PoolConfig = {
  concurrency: 1,
  worktree: {
    enabled: false,
    strategy: "pr",
    baseBranch: "main",
    cleanupOnSuccess: true,
    cleanupOnFailure: true,
    prLabels: ["tasksmith", "automated"],
  },
};

// ── Git Worktree Manager ────────────────────────────────────────────

export interface WorktreeInfo {
  taskId: string;
  branch: string;
  path: string;
  baseBranch: string;
}

export class WorktreeManager {
  private worktreeBaseDir: string;

  constructor(
    private workspace: string,
    private config: WorktreeConfig,
    private log: Logger,
  ) {
    this.worktreeBaseDir = join(workspace, ".tasksmith", "worktrees");
    mkdirSync(this.worktreeBaseDir, { recursive: true });
  }

  /** Check if workspace is inside a git repo */
  isGitRepo(): boolean {
    const res = spawnSync("git", ["rev-parse", "--git-dir"], {
      cwd: this.workspace,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return res.status === 0;
  }

  /** Check if gh CLI is available (needed for PR strategy) */
  hasGhCli(): boolean {
    const res = spawnSync("gh", ["--version"], { encoding: "utf-8", stdio: "pipe" });
    return res.status === 0;
  }

  /** Create an isolated worktree for a task */
  create(task: Task): WorktreeInfo | null {
    const branch = (task.params.worktree_branch as string) ||
      `tasksmith/${task.template}/${task.id}`;
    const wtPath = join(this.worktreeBaseDir, task.id);
    const base = this.config.baseBranch;

    this.log.info(`Creating worktree: ${branch} (from ${base})`);

    // Create a new branch from base and attach a worktree
    const res = spawnSync("git", [
      "worktree", "add",
      "-b", branch,
      wtPath,
      base,
    ], {
      cwd: this.workspace,
      encoding: "utf-8",
      stdio: "pipe",
    });

    if (res.status !== 0) {
      this.log.error(`Worktree create failed: ${(res.stderr || res.stdout || "").trim()}`);
      return null;
    }

    return { taskId: task.id, branch, path: wtPath, baseBranch: base };
  }

  /** Finalize a worktree after task execution */
  async finalize(wt: WorktreeInfo, task: Task, success: boolean): Promise<string | null> {
    const strategy = (task.params.worktree_strategy as WorktreeStrategy) || this.config.strategy;

    if (!success) {
      this.log.info(`Task failed — discarding worktree ${wt.branch}`);
      if (this.config.cleanupOnFailure) this.remove(wt);
      return null;
    }

    // Check if there are any changes to commit
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: wt.path, encoding: "utf-8", stdio: "pipe",
    });

    const hasChanges = (status.stdout || "").trim().length > 0;

    if (!hasChanges) {
      this.log.info("No changes in worktree — nothing to merge");
      if (this.config.cleanupOnSuccess) this.remove(wt);
      return null;
    }

    // Stage and commit any uncommitted changes
    spawnSync("git", ["add", "-A"], { cwd: wt.path, encoding: "utf-8", stdio: "pipe" });

    const commitMsg = `[tasksmith] ${task.template}: ${task.prompt.slice(0, 72)}`;
    spawnSync("git", ["commit", "-m", commitMsg], {
      cwd: wt.path, encoding: "utf-8", stdio: "pipe",
    });

    let result: string | null = null;

    // "local" strategy stays entirely on disk — no push, no merge, no cleanup.
    // The worktree and branch remain for manual review.
    if (strategy === "local") {
      result = `Local worktree ready: ${wt.path} (branch: ${wt.branch})`;
      this.log.info(`Local worktree preserved: ${wt.path} — branch: ${wt.branch}`);
      return result;
    }

    // All other strategies push the branch first
    const push = spawnSync("git", ["push", "origin", wt.branch], {
      cwd: wt.path, encoding: "utf-8", stdio: "pipe",
    });

    if (push.status !== 0) {
      this.log.warn(`Push failed: ${(push.stderr || "").trim()}`);
      // Still try strategies that work locally
    }

    switch (strategy) {
      case "pr":
        result = this.createPR(wt, task);
        break;
      case "auto-merge":
        result = this.autoMerge(wt, task);
        break;
      case "branch-only":
        result = `Branch created: ${wt.branch}`;
        this.log.info(`Branch ready: ${wt.branch}`);
        break;
    }

    if (this.config.cleanupOnSuccess && strategy !== "branch-only") {
      this.remove(wt);
    }

    return result;
  }

  /** Create a GitHub PR via gh CLI */
  private createPR(wt: WorktreeInfo, task: Task): string | null {
    if (!this.hasGhCli()) {
      this.log.warn("gh CLI not found — falling back to branch-only. Install: https://cli.github.com");
      return `Branch created: ${wt.branch} (install gh CLI for auto-PR)`;
    }

    const title = `[TaskSmith] ${task.template}: ${task.prompt.slice(0, 60)}`;
    const body = [
      `Automated PR created by TaskSmith.`,
      ``,
      `**Task:** \`${task.id}\``,
      `**Template:** ${task.template}`,
      `**Project:** ${task.project || "none"}`,
      `**Model:** ${task.model}`,
      `**Iterations:** ${task.iterations}`,
      ``,
      `**Prompt:**`,
      `> ${task.prompt.slice(0, 500)}`,
      ``,
      `---`,
      `*This PR was created automatically by [TaskSmith](https://tasksmith.dev).*`,
    ].join("\n");

    const args = [
      "pr", "create",
      "--base", wt.baseBranch,
      "--head", wt.branch,
      "--title", title,
      "--body", body,
    ];

    for (const label of this.config.prLabels) {
      args.push("--label", label);
    }

    const res = spawnSync("gh", args, {
      cwd: wt.path,
      encoding: "utf-8",
      stdio: "pipe",
    });

    if (res.status === 0) {
      const prUrl = (res.stdout || "").trim();
      this.log.info(`PR created: ${prUrl}`);
      return prUrl;
    } else {
      this.log.warn(`PR creation failed: ${(res.stderr || "").trim()}`);
      return `Branch created: ${wt.branch} (PR creation failed)`;
    }
  }

  /** Auto-merge branch into base */
  private autoMerge(wt: WorktreeInfo, task: Task): string | null {
    // Switch to base branch in main repo and merge
    const merge = spawnSync("git", ["merge", wt.branch, "--no-ff", "-m",
      `[tasksmith] Merge ${wt.branch}: ${task.prompt.slice(0, 60)}`
    ], {
      cwd: this.workspace,
      encoding: "utf-8",
      stdio: "pipe",
    });

    if (merge.status === 0) {
      this.log.info(`Auto-merged ${wt.branch} into ${wt.baseBranch}`);
      // Optionally push
      spawnSync("git", ["push"], { cwd: this.workspace, encoding: "utf-8", stdio: "pipe" });
      return `Merged ${wt.branch} → ${wt.baseBranch}`;
    } else {
      this.log.warn(`Auto-merge failed (conflicts?): ${(merge.stderr || "").trim()}`);
      this.log.info("Falling back to PR strategy");
      return this.createPR(wt, task);
    }
  }

  /** Remove a worktree and its branch */
  remove(wt: WorktreeInfo): void {
    try {
      spawnSync("git", ["worktree", "remove", wt.path, "--force"], {
        cwd: this.workspace, encoding: "utf-8", stdio: "pipe",
      });
      // Delete the branch if it wasn't merged
      spawnSync("git", ["branch", "-D", wt.branch], {
        cwd: this.workspace, encoding: "utf-8", stdio: "pipe",
      });
    } catch {
      // Best effort cleanup
      if (existsSync(wt.path)) {
        try { rmSync(wt.path, { recursive: true, force: true }); } catch { /* */ }
      }
    }
  }

  /** List active worktrees */
  list(): WorktreeInfo[] {
    const res = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: this.workspace, encoding: "utf-8", stdio: "pipe",
    });

    if (res.status !== 0) return [];

    const worktrees: WorktreeInfo[] = [];
    const blocks = (res.stdout || "").split("\n\n");

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const wtPath = lines.find(l => l.startsWith("worktree "))?.slice(9);
      const branch = lines.find(l => l.startsWith("branch "))?.slice(7).replace("refs/heads/", "");

      if (wtPath && branch && branch.startsWith("tasksmith/")) {
        const taskId = wtPath.split("/").pop() || "";
        worktrees.push({ taskId, branch, path: wtPath, baseBranch: this.config.baseBranch });
      }
    }

    return worktrees;
  }
}

// ── Worker Pool ─────────────────────────────────────────────────────

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface WorkerSlot {
  taskId: string;
  task: Task;
  worktree: WorktreeInfo | null;
  promise: Promise<void>;
}

type TaskExecutor = (task: Task, cwd?: string) => Promise<void>;

export class WorkerPool {
  private active = new Map<string, WorkerSlot>();
  private queue: Task[] = [];
  private worktreeManager: WorktreeManager | null = null;
  private config: PoolConfig;
  private paused = false;
  private onTaskComplete: ((task: Task, worktreeResult: string | null) => void) | null = null;

  constructor(
    workspace: string,
    config: Partial<PoolConfig>,
    private executor: TaskExecutor,
    private log: Logger,
  ) {
    this.config = {
      ...POOL_DEFAULTS,
      ...config,
      worktree: {
        ...POOL_DEFAULTS.worktree,
        ...(config.worktree || {}),
      },
    };

    // Initialize worktree manager if enabled and in a git repo
    if (this.config.worktree.enabled) {
      const wm = new WorktreeManager(workspace, this.config.worktree, log);
      if (wm.isGitRepo()) {
        this.worktreeManager = wm;
        log.info(`Worktree isolation enabled (strategy: ${this.config.worktree.strategy}, base: ${this.config.worktree.baseBranch})`);
      } else {
        log.warn("Worktree isolation enabled but workspace is not a git repo — disabled");
      }
    }

    log.info(`Worker pool: concurrency=${this.config.concurrency}`);
  }

  /** Set callback for when tasks complete (used by coordinator for plugin hooks) */
  onComplete(cb: (task: Task, worktreeResult: string | null) => void): void {
    this.onTaskComplete = cb;
  }

  /** Submit a task to the pool */
  submit(task: Task): void {
    if (this.active.size < this.config.concurrency) {
      this.startWorker(task);
    } else {
      // Insert by priority (urgent first)
      const priorityOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
      const p = priorityOrder[task.priority] ?? 2;
      const idx = this.queue.findIndex(t => (priorityOrder[t.priority] ?? 2) > p);
      if (idx === -1) {
        this.queue.push(task);
      } else {
        this.queue.splice(idx, 0, task);
      }
      this.log.info(`Queued ${task.id} (${this.queue.length} in queue, ${this.active.size}/${this.config.concurrency} active)`);
    }
  }

  /** Start executing a task in a worker slot */
  private startWorker(task: Task): void {
    const useWorktree = this.worktreeManager &&
      task.params.worktree !== false &&
      this.config.worktree.enabled;

    let worktree: WorktreeInfo | null = null;

    if (useWorktree && this.worktreeManager) {
      worktree = this.worktreeManager.create(task);
      if (worktree) {
        this.log.info(`[${task.id}] Isolated in worktree: ${worktree.branch}`);
      }
    }

    const promise = this.runTask(task, worktree);
    this.active.set(task.id, { taskId: task.id, task, worktree, promise });

    this.log.info(`[${task.id}] Started (${this.active.size}/${this.config.concurrency} slots)`);
  }

  /** Execute a task, handle worktree finalization, then dequeue next */
  private async runTask(task: Task, worktree: WorktreeInfo | null): Promise<void> {
    let worktreeResult: string | null = null;

    try {
      // Execute task — if worktree, pass its path as cwd override
      await this.executor(task, worktree?.path);

      // Finalize worktree (merge/PR/branch)
      if (worktree && this.worktreeManager) {
        const success = task.status === "completed";
        worktreeResult = await this.worktreeManager.finalize(worktree, task, success);

        if (worktreeResult) {
          // Append worktree result to task result
          task.result = [task.result, `Worktree: ${worktreeResult}`].filter(Boolean).join("\n");
        }
      }
    } catch (e: any) {
      this.log.error(`[${task.id}] Worker error: ${e.message}`);
      if (worktree && this.worktreeManager) {
        this.worktreeManager.remove(worktree);
      }
    } finally {
      this.active.delete(task.id);

      // Notify coordinator
      if (this.onTaskComplete) {
        this.onTaskComplete(task, worktreeResult);
      }

      // Dequeue next task if available
      if (!this.paused && this.queue.length > 0 && this.active.size < this.config.concurrency) {
        const next = this.queue.shift()!;
        this.startWorker(next);
      }
    }
  }

  /** Get pool status */
  status(): { active: number; queued: number; concurrency: number; tasks: string[] } {
    return {
      active: this.active.size,
      queued: this.queue.length,
      concurrency: this.config.concurrency,
      tasks: [...this.active.values()].map(s =>
        `${s.taskId} (${s.worktree ? `wt:${s.worktree.branch}` : "direct"})`
      ),
    };
  }

  /** Pause accepting new tasks from queue */
  pause(): void { this.paused = true; }

  /** Resume dequeuing */
  resume(): void {
    this.paused = false;
    // Drain queue up to concurrency
    while (this.queue.length > 0 && this.active.size < this.config.concurrency) {
      const next = this.queue.shift()!;
      this.startWorker(next);
    }
  }

  /** Wait for all active tasks to complete */
  async drain(): Promise<void> {
    const promises = [...this.active.values()].map(s => s.promise);
    await Promise.allSettled(promises);
  }

  /** Get worktree info */
  getWorktreeManager(): WorktreeManager | null {
    return this.worktreeManager;
  }
}
