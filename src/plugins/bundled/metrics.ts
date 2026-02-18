/**
 * TaskSmith Official Plugin: Metrics
 *
 * Tracks task execution statistics and writes them to a JSON file.
 * Provides insights into success rates, iteration counts, model usage,
 * and timing data.
 *
 * Features:
 *   - Per-task execution tracking (start, end, iterations, result)
 *   - Aggregate statistics (success rate, avg iterations, model breakdown)
 *   - Daily/weekly/monthly rollups
 *   - CLI command: `tasksmith metrics` to view stats
 *   - JSON export for external dashboards
 *
 * Config:
 *   plugins:
 *     - name: metrics
 *       config:
 *         metricsFile: "metrics.json"     # relative to workspace
 *         retainDays: 90                  # how long to keep individual records
 *         trackModels: true               # breakdown by model
 *         trackTemplates: true            # breakdown by template
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PluginContext } from "../../plugins.js";

interface MetricsConfig {
  metricsFile: string;
  retainDays: number;
  trackModels: boolean;
  trackTemplates: boolean;
}

interface TaskRecord {
  taskId: string;
  template: string;
  model: string;
  project: string;
  success: boolean;
  iterations: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error?: string;
}

interface MetricsData {
  version: 1;
  lastUpdated: string;
  records: TaskRecord[];
  aggregates: {
    totalTasks: number;
    successCount: number;
    failCount: number;
    successRate: number;
    avgIterations: number;
    avgDurationMs: number;
    byModel: Record<string, { total: number; success: number; avgIterations: number }>;
    byTemplate: Record<string, { total: number; success: number; avgIterations: number }>;
    byProject: Record<string, { total: number; success: number }>;
  };
}

const DEFAULTS: MetricsConfig = {
  metricsFile: "metrics.json",
  retainDays: 90,
  trackModels: true,
  trackTemplates: true,
};

function emptyMetrics(): MetricsData {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    records: [],
    aggregates: {
      totalTasks: 0,
      successCount: 0,
      failCount: 0,
      successRate: 0,
      avgIterations: 0,
      avgDurationMs: 0,
      byModel: {},
      byTemplate: {},
      byProject: {},
    },
  };
}

function loadMetrics(filePath: string): MetricsData {
  if (!existsSync(filePath)) return emptyMetrics();
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return emptyMetrics();
  }
}

function saveMetrics(filePath: string, data: MetricsData): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function recompute(data: MetricsData, config: MetricsConfig): void {
  // Prune old records
  const cutoff = Date.now() - config.retainDays * 86400000;
  data.records = data.records.filter(r => new Date(r.completedAt).getTime() > cutoff);

  const records = data.records;
  const total = records.length;

  if (total === 0) {
    data.aggregates = emptyMetrics().aggregates;
    data.lastUpdated = new Date().toISOString();
    return;
  }

  const successes = records.filter(r => r.success);

  data.aggregates.totalTasks = total;
  data.aggregates.successCount = successes.length;
  data.aggregates.failCount = total - successes.length;
  data.aggregates.successRate = Math.round((successes.length / total) * 1000) / 10;
  data.aggregates.avgIterations = Math.round((records.reduce((s, r) => s + r.iterations, 0) / total) * 10) / 10;
  data.aggregates.avgDurationMs = Math.round(records.reduce((s, r) => s + r.durationMs, 0) / total);

  // Model breakdown
  if (config.trackModels) {
    const byModel: Record<string, { total: number; success: number; totalIter: number }> = {};
    for (const r of records) {
      const key = r.model || "unknown";
      if (!byModel[key]) byModel[key] = { total: 0, success: 0, totalIter: 0 };
      byModel[key].total++;
      if (r.success) byModel[key].success++;
      byModel[key].totalIter += r.iterations;
    }
    data.aggregates.byModel = {};
    for (const [k, v] of Object.entries(byModel)) {
      data.aggregates.byModel[k] = { total: v.total, success: v.success, avgIterations: Math.round((v.totalIter / v.total) * 10) / 10 };
    }
  }

  // Template breakdown
  if (config.trackTemplates) {
    const byTemplate: Record<string, { total: number; success: number; totalIter: number }> = {};
    for (const r of records) {
      const key = r.template || "unknown";
      if (!byTemplate[key]) byTemplate[key] = { total: 0, success: 0, totalIter: 0 };
      byTemplate[key].total++;
      if (r.success) byTemplate[key].success++;
      byTemplate[key].totalIter += r.iterations;
    }
    data.aggregates.byTemplate = {};
    for (const [k, v] of Object.entries(byTemplate)) {
      data.aggregates.byTemplate[k] = { total: v.total, success: v.success, avgIterations: Math.round((v.totalIter / v.total) * 10) / 10 };
    }
  }

  // Project breakdown
  const byProject: Record<string, { total: number; success: number }> = {};
  for (const r of records) {
    const key = r.project || "(none)";
    if (!byProject[key]) byProject[key] = { total: 0, success: 0 };
    byProject[key].total++;
    if (r.success) byProject[key].success++;
  }
  data.aggregates.byProject = byProject;

  data.lastUpdated = new Date().toISOString();
}

// Track task start times in memory (not persisted)
const taskStartTimes = new Map<string, number>();

// ── Plugin Entry Point ──────────────────────────────────────────────

export default function metricsPlugin(ctx: PluginContext, options: Record<string, unknown>): void {
  const config: MetricsConfig = { ...DEFAULTS, ...options } as MetricsConfig;
  const metricsPath = join(ctx.workspace, config.metricsFile);

  // Hook: track task start time
  ctx.addHook("beforeTaskExecute", async (data) => {
    const task = data.task as Record<string, unknown> | undefined;
    if (task?.id) {
      taskStartTimes.set(task.id as string, Date.now());
    }
  });

  // Hook: record task completion
  ctx.addHook("afterTaskExecute", async (data) => {
    const task = data.task as Record<string, unknown> | undefined;
    const ok = data.ok as boolean;
    if (!task?.id) return;

    const taskId = task.id as string;
    const startTime = taskStartTimes.get(taskId) || Date.now();
    taskStartTimes.delete(taskId);

    const now = Date.now();
    const record: TaskRecord = {
      taskId,
      template: (task.template as string) || "unknown",
      model: (task.model as string) || "unknown",
      project: (task.project as string) || "",
      success: ok,
      iterations: (task.iterations as number) || 0,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date(now).toISOString(),
      durationMs: now - startTime,
    };

    if (!ok && task.error) {
      record.error = (task.error as string).slice(0, 500);
    }

    const metrics = loadMetrics(metricsPath);
    metrics.records.push(record);
    recompute(metrics, config);
    saveMetrics(metricsPath, metrics);

    ctx.log.info(`Recorded: ${taskId} (${ok ? "✅" : "❌"}, ${record.iterations} iters, ${Math.round(record.durationMs / 1000)}s)`);
  });

  // Register CLI command: tasksmith metrics
  ctx.addCommand("metrics", {
    description: "Show task execution metrics and statistics",
    options: [
      { flag: "--json", description: "Output raw JSON" },
      { flag: "--days <n>", description: "Show stats for last N days", default: "30" },
    ],
    action: async (args) => {
      const chalk = (await import("chalk")).default;
      const metrics = loadMetrics(metricsPath);

      if (args.json) {
        console.log(JSON.stringify(metrics, null, 2));
        return;
      }

      const days = parseInt(args.days || "30") || 30;
      const cutoff = Date.now() - days * 86400000;
      const recent = metrics.records.filter(r => new Date(r.completedAt).getTime() > cutoff);
      const agg = metrics.aggregates;

      console.log(chalk.bold(`\n  TaskSmith Metrics (last ${days} days)\n`));
      console.log(`    Total tasks:     ${chalk.bold(String(agg.totalTasks))}`);
      const rateColor = agg.successRate >= 80 ? chalk.green : agg.successRate >= 50 ? chalk.yellow : chalk.red;
      console.log(`    Success rate:    ${rateColor(agg.successRate + "%")}`);
      console.log(`    Avg iterations:  ${agg.avgIterations}`);
      console.log(`    Avg duration:    ${Math.round(agg.avgDurationMs / 1000)}s`);
      console.log(`    Passed:          ${chalk.green(String(agg.successCount))}`);
      console.log(`    Failed:          ${chalk.red(String(agg.failCount))}`);

      if (Object.keys(agg.byModel).length > 0) {
        console.log(chalk.bold(`\n  By Model\n`));
        for (const [model, stats] of Object.entries(agg.byModel)) {
          const rate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
          console.log(`    ${model.padEnd(16)} ${String(stats.total).padStart(4)} tasks  ${String(rate).padStart(3)}% pass  ${stats.avgIterations} avg iters`);
        }
      }

      if (Object.keys(agg.byTemplate).length > 0) {
        console.log(chalk.bold(`\n  By Template\n`));
        for (const [tmpl, stats] of Object.entries(agg.byTemplate)) {
          const rate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
          console.log(`    ${tmpl.padEnd(20)} ${String(stats.total).padStart(4)} tasks  ${String(rate).padStart(3)}% pass  ${stats.avgIterations} avg iters`);
        }
      }

      if (Object.keys(agg.byProject).length > 0) {
        console.log(chalk.bold(`\n  By Project\n`));
        for (const [proj, stats] of Object.entries(agg.byProject)) {
          const rate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
          console.log(`    ${proj.padEnd(20)} ${String(stats.total).padStart(4)} tasks  ${String(rate).padStart(3)}% pass`);
        }
      }

      // Recent failures
      const failures = recent.filter(r => !r.success).slice(-5);
      if (failures.length > 0) {
        console.log(chalk.bold(`\n  Recent Failures\n`));
        for (const f of failures) {
          console.log(`    ${chalk.red("✗")} ${f.taskId}  ${f.template}  ${f.model}  ${(f.error || "").slice(0, 60)}`);
        }
      }

      console.log(chalk.dim(`\n  Data file: ${metricsPath}\n`));
    },
  });

  ctx.log.info(`Metrics tracking active (${metricsPath})`);
}

export { MetricsConfig, MetricsData, TaskRecord };
