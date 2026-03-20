/**
 * TaskSmith Worker Pool
 *
 * Manages parallel task execution with configurable concurrency.
 * Worktree isolation is delegated to Claude Code via the --worktree flag.
 *
 * Config in tasksmith.yaml:
 *
 *   engine:
 *     concurrency: 3    # max parallel tasks (default: 1)
 */

import type { Task } from "./types.js";

// ── Config Types ────────────────────────────────────────────────────

export interface PoolConfig {
  concurrency: number;
}

export const POOL_DEFAULTS: PoolConfig = {
  concurrency: 1,
};

// ── Worker Pool ─────────────────────────────────────────────────────

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface WorkerSlot {
  taskId: string;
  task: Task;
  promise: Promise<void>;
}

type TaskExecutor = (task: Task) => Promise<void>;

export class WorkerPool {
  private active = new Map<string, WorkerSlot>();
  private queue: Task[] = [];
  private config: PoolConfig;
  private paused = false;
  private onTaskComplete: ((task: Task) => void) | null = null;

  constructor(
    private workspace: string,
    config: Partial<PoolConfig>,
    private executor: TaskExecutor,
    private log: Logger,
  ) {
    this.config = { ...POOL_DEFAULTS, ...config };
    log.info(`Worker pool: concurrency=${this.config.concurrency}`);
  }

  /** Set callback for when tasks complete (used by coordinator for plugin hooks) */
  onComplete(cb: (task: Task) => void): void {
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
    const promise = this.runTask(task);
    this.active.set(task.id, { taskId: task.id, task, promise });
    this.log.info(`[${task.id}] Started (${this.active.size}/${this.config.concurrency} slots)`);
  }

  /** Execute a task, then dequeue next */
  private async runTask(task: Task): Promise<void> {
    try {
      await this.executor(task);
    } catch (e: any) {
      this.log.error(`[${task.id}] Worker error: ${e.message}`);
    } finally {
      this.active.delete(task.id);

      // Notify coordinator
      if (this.onTaskComplete) {
        this.onTaskComplete(task);
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
      tasks: [...this.active.values()].map(s => s.taskId),
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
}
