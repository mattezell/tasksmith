/**
 * TaskSmith Scheduler
 *
 * Lightweight cron-like scheduler that creates tasks on a schedule.
 * No dependencies — uses built-in timers with minute-level granularity.
 *
 * Config in tasksmith.yaml:
 *
 *   schedules:
 *     - name: "nightly-consolidation"
 *       template: heartbeat
 *       prompt: "Consolidate memory, prune stale entries, summarize today"
 *       cron: "0 2 * * *"           # 2 AM daily
 *       project: ""                  # optional
 *       model: sonnet
 *       enabled: true
 *
 *     - name: "health-check"
 *       template: heartbeat
 *       prompt: "Run health checks on all projects"
 *       cron: "0 0/6 * * *"          # every 6 hours
 *       enabled: true
 *
 *     - name: "weekly-review"
 *       template: research
 *       prompt: "Generate weekly progress report across all projects"
 *       cron: "0 9 * * 1"           # Monday 9 AM
 *       enabled: true
 *
 * Cron format: minute hour day-of-month month day-of-week
 *   - Standard 5-field cron syntax
 *   - Supports *, ranges (1-5), steps (asterisk/2), and lists (1,3,5)
 *   - Day of week: 0=Sun, 1=Mon, ..., 6=Sat
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import yaml from "js-yaml";

// ── Cron Parser ─────────────────────────────────────────────────────

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      let start = min;
      let end = max;
      if (range !== "*") {
        if (range.includes("-")) {
          const [lo, hi] = range.split("-").map(Number);
          start = lo;
          end = hi;
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      for (let i = lo; i <= hi; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return values;
}

function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    return {
      minutes: parseField(parts[0], 0, 59),
      hours: parseField(parts[1], 0, 23),
      daysOfMonth: parseField(parts[2], 1, 31),
      months: parseField(parts[3], 1, 12),
      daysOfWeek: parseField(parts[4], 0, 6),
    };
  } catch {
    return null;
  }
}

function matchesCron(fields: CronFields, date: Date): boolean {
  return (
    fields.minutes.has(date.getMinutes()) &&
    fields.hours.has(date.getHours()) &&
    fields.daysOfMonth.has(date.getDate()) &&
    fields.months.has(date.getMonth() + 1) &&
    fields.daysOfWeek.has(date.getDay())
  );
}

// ── Human-readable cron description ─────────────────────────────────

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [min, hour, dom, mon, dow] = parts;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Common patterns
  if (min !== "*" && hour !== "*" && dom === "*" && mon === "*" && dow === "*") {
    return `daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  if (min !== "*" && hour !== "*" && dom === "*" && mon === "*" && dow !== "*") {
    const days = dow.split(",").map(d => dayNames[parseInt(d)] || d).join(", ");
    return `${days} at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  if (hour.includes("/")) {
    return `every ${hour.split("/")[1]} hours`;
  }
  if (min.includes("/")) {
    return `every ${min.split("/")[1]} minutes`;
  }

  return expr;
}

// ── Schedule Entry ──────────────────────────────────────────────────

export interface ScheduleEntry {
  name: string;
  template: string;
  prompt: string;
  cron: string;
  project?: string;
  model?: string;
  priority?: string;
  enabled?: boolean;
  params?: Record<string, unknown>;
}

// ── Scheduler ───────────────────────────────────────────────────────

export class Scheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private parsedSchedules: Array<{ entry: ScheduleEntry; fields: CronFields }> = [];
  private lastCheck = -1; // last minute we checked (avoid double-fire)

  constructor(
    private schedules: ScheduleEntry[],
    private inboxDir: string,
    private log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
  ) {
    for (const entry of schedules) {
      if (entry.enabled === false) continue;

      const fields = parseCron(entry.cron);
      if (!fields) {
        this.log.warn(`Invalid cron expression for schedule "${entry.name}": ${entry.cron}`);
        continue;
      }
      this.parsedSchedules.push({ entry, fields });
    }
  }

  start(): void {
    if (this.parsedSchedules.length === 0) return;

    this.log.info(`Scheduler active (${this.parsedSchedules.length} schedule${this.parsedSchedules.length === 1 ? "" : "s"})`);
    for (const { entry } of this.parsedSchedules) {
      this.log.info(`  ⏰ ${entry.name}: ${describeCron(entry.cron)} → ${entry.template}`);
    }

    // Check every 30 seconds (catches the minute boundary reliably)
    this.interval = setInterval(() => this.tick(), 30_000);

    // Also tick immediately in case we start exactly on a boundary
    this.tick();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private tick(): void {
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();

    // Only fire once per minute
    if (currentMinute === this.lastCheck) return;
    this.lastCheck = currentMinute;

    for (const { entry, fields } of this.parsedSchedules) {
      if (matchesCron(fields, now)) {
        this.createTask(entry);
      }
    }
  }

  private createTask(entry: ScheduleEntry): void {
    const taskId = `sched-${entry.name}-${Date.now()}`;
    const task: Record<string, unknown> = {
      id: taskId,
      template: entry.template,
      prompt: entry.prompt,
      model: entry.model || "sonnet",
      priority: entry.priority || "normal",
    };

    if (entry.project) task.project = entry.project;
    if (entry.params) task.params = entry.params;

    const taskPath = join(this.inboxDir, `${taskId}.yaml`);

    try {
      writeFileSync(taskPath, yaml.dump(task), "utf-8");
      this.log.info(`Scheduled task created: ${entry.name} → ${taskPath}`);
    } catch (e: any) {
      this.log.error(`Failed to create scheduled task "${entry.name}": ${e.message}`);
    }
  }

  /** Get schedule info for CLI display */
  getScheduleInfo(): Array<{ name: string; cron: string; description: string; template: string; enabled: boolean }> {
    return this.schedules.map(s => ({
      name: s.name,
      cron: s.cron,
      description: describeCron(s.cron),
      template: s.template,
      enabled: s.enabled !== false,
    }));
  }
}

export { parseCron, matchesCron, describeCron };
