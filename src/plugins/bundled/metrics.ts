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
  costUsd?: number;
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
    totalCostUsd: number;
    avgCostUsd: number;
    byModel: Record<string, { total: number; success: number; avgIterations: number; totalCostUsd: number }>;
    byTemplate: Record<string, { total: number; success: number; avgIterations: number; totalCostUsd: number }>;
    byProject: Record<string, { total: number; success: number; totalCostUsd: number }>;
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
      totalCostUsd: 0,
      avgCostUsd: 0,
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

  // Cost aggregation
  const totalCost = records.reduce((s, r) => s + (r.costUsd || 0), 0);
  data.aggregates.totalCostUsd = Math.round(totalCost * 10000) / 10000;
  data.aggregates.avgCostUsd = Math.round((totalCost / total) * 10000) / 10000;

  // Model breakdown
  if (config.trackModels) {
    const byModel: Record<string, { total: number; success: number; totalIter: number; totalCost: number }> = {};
    for (const r of records) {
      const key = r.model || "unknown";
      if (!byModel[key]) byModel[key] = { total: 0, success: 0, totalIter: 0, totalCost: 0 };
      byModel[key].total++;
      if (r.success) byModel[key].success++;
      byModel[key].totalIter += r.iterations;
      byModel[key].totalCost += r.costUsd || 0;
    }
    data.aggregates.byModel = {};
    for (const [k, v] of Object.entries(byModel)) {
      data.aggregates.byModel[k] = { total: v.total, success: v.success, avgIterations: Math.round((v.totalIter / v.total) * 10) / 10, totalCostUsd: Math.round(v.totalCost * 10000) / 10000 };
    }
  }

  // Template breakdown
  if (config.trackTemplates) {
    const byTemplate: Record<string, { total: number; success: number; totalIter: number; totalCost: number }> = {};
    for (const r of records) {
      const key = r.template || "unknown";
      if (!byTemplate[key]) byTemplate[key] = { total: 0, success: 0, totalIter: 0, totalCost: 0 };
      byTemplate[key].total++;
      if (r.success) byTemplate[key].success++;
      byTemplate[key].totalIter += r.iterations;
      byTemplate[key].totalCost += r.costUsd || 0;
    }
    data.aggregates.byTemplate = {};
    for (const [k, v] of Object.entries(byTemplate)) {
      data.aggregates.byTemplate[k] = { total: v.total, success: v.success, avgIterations: Math.round((v.totalIter / v.total) * 10) / 10, totalCostUsd: Math.round(v.totalCost * 10000) / 10000 };
    }
  }

  // Project breakdown
  const byProject: Record<string, { total: number; success: number; totalCost: number }> = {};
  for (const r of records) {
    const key = r.project || "(none)";
    if (!byProject[key]) byProject[key] = { total: 0, success: 0, totalCost: 0 };
    byProject[key].total++;
    if (r.success) byProject[key].success++;
    byProject[key].totalCost += r.costUsd || 0;
  }
  data.aggregates.byProject = {};
  for (const [k, v] of Object.entries(byProject)) {
    data.aggregates.byProject[k] = { total: v.total, success: v.success, totalCostUsd: Math.round(v.totalCost * 10000) / 10000 };
  }

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
    // Extract cost from task diagnostics (set by engine's Ralph Loop)
    const diag = (task as any).diagnostics as Record<string, any> | undefined;
    const costUsd = diag?.total_cost_usd as number | undefined;

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

    if (costUsd != null && costUsd > 0) {
      record.costUsd = Math.round(costUsd * 10000) / 10000;
    }

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
      if (agg.totalCostUsd > 0) {
        console.log(`    Total cost:      ${chalk.yellow("$" + agg.totalCostUsd.toFixed(4))}`);
        console.log(`    Avg cost/task:   ${chalk.yellow("$" + agg.avgCostUsd.toFixed(4))}`);
      }

      if (Object.keys(agg.byModel).length > 0) {
        console.log(chalk.bold(`\n  By Model\n`));
        for (const [model, stats] of Object.entries(agg.byModel)) {
          const rate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
          const cost = stats.totalCostUsd > 0 ? `  $${stats.totalCostUsd.toFixed(4)}` : "";
          console.log(`    ${model.padEnd(16)} ${String(stats.total).padStart(4)} tasks  ${String(rate).padStart(3)}% pass  ${stats.avgIterations} avg iters${cost}`);
        }
      }

      if (Object.keys(agg.byTemplate).length > 0) {
        console.log(chalk.bold(`\n  By Template\n`));
        for (const [tmpl, stats] of Object.entries(agg.byTemplate)) {
          const rate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
          const cost = stats.totalCostUsd > 0 ? `  $${stats.totalCostUsd.toFixed(4)}` : "";
          console.log(`    ${tmpl.padEnd(20)} ${String(stats.total).padStart(4)} tasks  ${String(rate).padStart(3)}% pass  ${stats.avgIterations} avg iters${cost}`);
        }
      }

      if (Object.keys(agg.byProject).length > 0) {
        console.log(chalk.bold(`\n  By Project\n`));
        for (const [proj, stats] of Object.entries(agg.byProject)) {
          const rate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
          const cost = stats.totalCostUsd > 0 ? `  $${stats.totalCostUsd.toFixed(4)}` : "";
          console.log(`    ${proj.padEnd(20)} ${String(stats.total).padStart(4)} tasks  ${String(rate).padStart(3)}% pass${cost}`);
        }
      }

      // Smart routing savings estimate
      // Compare actual cost vs. hypothetical "everything on opus" cost
      if (agg.totalCostUsd > 0 && Object.keys(agg.byModel).length > 1) {
        // Approximate cost multipliers relative to opus (opus = 1x)
        const costMultiplier: Record<string, number> = {
          haiku: 0.04,   // ~25x cheaper than opus
          sonnet: 0.2,   // ~5x cheaper than opus
          opus: 1.0,
        };

        let hypotheticalOpusCost = 0;
        for (const [model, stats] of Object.entries(agg.byModel)) {
          if (stats.totalCostUsd <= 0) continue;
          const multiplier = costMultiplier[model];
          if (multiplier && multiplier < 1) {
            // Scale up: if this cost X on sonnet, it would cost X/0.2 on opus
            hypotheticalOpusCost += stats.totalCostUsd / multiplier;
          } else {
            hypotheticalOpusCost += stats.totalCostUsd;
          }
        }

        const saved = hypotheticalOpusCost - agg.totalCostUsd;
        if (saved > 0.001) {
          const pct = Math.round((saved / hypotheticalOpusCost) * 100);
          console.log(chalk.bold(`\n  Smart Routing Savings\n`));
          console.log(`    Actual cost:     ${chalk.yellow("$" + agg.totalCostUsd.toFixed(4))}`);
          console.log(`    All-opus cost:   ${chalk.dim("$" + hypotheticalOpusCost.toFixed(4))}`);
          console.log(`    Saved:           ${chalk.green("$" + saved.toFixed(4))} (${pct}%)`);
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

  // Register CLI command: tasksmith insights
  ctx.addCommand("insights", {
    description: "Analyze task history for patterns and actionable observations",
    options: [
      { flag: "--days <n>", description: "Analyze last N days", default: "30" },
      { flag: "--json", description: "Output raw JSON" },
    ],
    action: async (args) => {
      const chalk = (await import("chalk")).default;
      const metrics = loadMetrics(metricsPath);

      const days = parseInt(args.days || "30") || 30;
      const cutoff = Date.now() - days * 86400000;
      const records = metrics.records.filter(r => new Date(r.completedAt).getTime() > cutoff);

      const insights = generateInsights(records, days);

      if (args.json) {
        console.log(JSON.stringify(insights, null, 2));
        return;
      }

      console.log(chalk.bold(`\n  TaskSmith Insights (last ${days} days)\n`));

      if (insights.length === 0) {
        console.log(chalk.dim("    Not enough data to generate insights. Run more tasks!\n"));
        return;
      }

      for (const insight of insights) {
        const icon = insight.type === "positive" ? chalk.green("▲") :
          insight.type === "negative" ? chalk.red("▼") : chalk.yellow("●");
        console.log(`    ${icon} ${insight.message}`);
      }
      console.log();
    },
  });

  ctx.log.info(`Metrics tracking active (${metricsPath})`);
}

// =============================================================================
// INSIGHTS ENGINE
// =============================================================================

interface Insight {
  type: "positive" | "negative" | "neutral";
  category: string;
  message: string;
}

function generateInsights(records: TaskRecord[], days: number): Insight[] {
  const insights: Insight[] = [];
  if (records.length < 3) return insights;

  // ── Model performance comparison ──────────────────────────────
  const byModel = groupBy(records, r => r.model);
  if (Object.keys(byModel).length > 1) {
    let bestModel = "";
    let bestRate = -1;
    let worstModel = "";
    let worstRate = 101;

    for (const [model, recs] of Object.entries(byModel)) {
      if (recs.length < 2) continue;
      const rate = recs.filter(r => r.success).length / recs.length;
      if (rate > bestRate) { bestRate = rate; bestModel = model; }
      if (rate < worstRate) { worstRate = rate; worstModel = model; }
    }

    if (bestModel && worstModel && bestModel !== worstModel && bestRate - worstRate > 0.15) {
      insights.push({
        type: "neutral",
        category: "model",
        message: `${bestModel} succeeds ${Math.round(bestRate * 100)}% vs ${worstModel} at ${Math.round(worstRate * 100)}% — consider routing more work to ${bestModel}`,
      });
    }
  }

  // ── Template-specific failure patterns ────────────────────────
  const byTemplate = groupBy(records, r => r.template);
  for (const [template, recs] of Object.entries(byTemplate)) {
    if (recs.length < 3) continue;
    const failRate = recs.filter(r => !r.success).length / recs.length;
    if (failRate > 0.5) {
      insights.push({
        type: "negative",
        category: "template",
        message: `"${template}" fails ${Math.round(failRate * 100)}% of the time (${recs.length} tasks) — review prompts or validation commands`,
      });
    } else if (failRate === 0 && recs.length >= 5) {
      insights.push({
        type: "positive",
        category: "template",
        message: `"${template}" has a perfect record: ${recs.length} tasks, 0 failures`,
      });
    }
  }

  // ── Iteration bloat — tasks needing many retries ──────────────
  const avgIter = records.reduce((s, r) => s + r.iterations, 0) / records.length;
  const highIterTasks = records.filter(r => r.iterations > avgIter * 2 && r.iterations > 3);
  if (highIterTasks.length > 0) {
    const pct = Math.round((highIterTasks.length / records.length) * 100);
    insights.push({
      type: "negative",
      category: "efficiency",
      message: `${highIterTasks.length} tasks (${pct}%) needed >2x avg iterations — prompts may be ambiguous or validation too strict`,
    });
  }

  // ── Time-of-day patterns ──────────────────────────────────────
  const hourBuckets: Record<string, { total: number; fail: number }> = {};
  for (const r of records) {
    const hour = new Date(r.startedAt).getHours();
    const bucket = hour < 6 ? "night (0-6)" : hour < 12 ? "morning (6-12)" : hour < 18 ? "afternoon (12-18)" : "evening (18-24)";
    if (!hourBuckets[bucket]) hourBuckets[bucket] = { total: 0, fail: 0 };
    hourBuckets[bucket].total++;
    if (!r.success) hourBuckets[bucket].fail++;
  }

  let worstPeriod = "";
  let worstFailRate = 0;
  for (const [period, stats] of Object.entries(hourBuckets)) {
    if (stats.total < 3) continue;
    const rate = stats.fail / stats.total;
    if (rate > worstFailRate && rate > 0.4) {
      worstFailRate = rate;
      worstPeriod = period;
    }
  }
  if (worstPeriod) {
    insights.push({
      type: "neutral",
      category: "timing",
      message: `Tasks submitted during ${worstPeriod} fail ${Math.round(worstFailRate * 100)}% — possible infra/rate-limit correlation`,
    });
  }

  // ── Cost outliers ─────────────────────────────────────────────
  const withCost = records.filter(r => r.costUsd && r.costUsd > 0);
  if (withCost.length >= 5) {
    const costs = withCost.map(r => r.costUsd!).sort((a, b) => a - b);
    const median = costs[Math.floor(costs.length / 2)];
    const expensive = withCost.filter(r => r.costUsd! > median * 3);
    if (expensive.length > 0) {
      const top = expensive.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0))[0];
      insights.push({
        type: "negative",
        category: "cost",
        message: `${expensive.length} tasks cost >3x median ($${median.toFixed(4)}). Most expensive: ${top.taskId} at $${top.costUsd!.toFixed(4)}`,
      });
    }
  }

  // ── Trend: improving or declining? ────────────────────────────
  if (records.length >= 10) {
    const sorted = [...records].sort((a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime());
    const half = Math.floor(sorted.length / 2);
    const firstHalf = sorted.slice(0, half);
    const secondHalf = sorted.slice(half);

    const firstRate = firstHalf.filter(r => r.success).length / firstHalf.length;
    const secondRate = secondHalf.filter(r => r.success).length / secondHalf.length;
    const delta = secondRate - firstRate;

    if (Math.abs(delta) > 0.1) {
      const direction = delta > 0 ? "improving" : "declining";
      insights.push({
        type: delta > 0 ? "positive" : "negative",
        category: "trend",
        message: `Success rate is ${direction}: ${Math.round(firstRate * 100)}% → ${Math.round(secondRate * 100)}% (first half vs second half)`,
      });
    }
  }

  return insights;
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  }
  return groups;
}

export { MetricsConfig, MetricsData, TaskRecord };
