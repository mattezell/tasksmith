/**
 * TaskSmith Official Plugin: Postgres
 *
 * Store task execution history in PostgreSQL for querying, dashboards,
 * and long-term analytics.
 *
 * Features:
 *   - Auto-create tables on first run
 *   - Record every task execution with full metadata
 *   - Searchable task history via SQL
 *   - CLI command: `tasksmith pg` to query history
 *
 * Config:
 *   plugins:
 *     - name: postgres
 *       config:
 *         connectionString: "postgresql://user:pass@localhost:5432/tasksmith"
 *         tableName: "task_history"
 *         autoMigrate: true              # create tables if they don't exist
 *
 * Requires: npm install pg (peer dependency, installed by user)
 */

import type { PluginContext } from "../../plugins.js";

interface PostgresConfig {
  connectionString: string;
  tableName: string;
  autoMigrate: boolean;
}

const DEFAULTS: PostgresConfig = {
  connectionString: "",
  tableName: "task_history",
  autoMigrate: true,
};

// Minimal pg wrapper that works without importing pg at module level
// (pg is a peer dep — user must install it)
interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

async function createClient(connectionString: string): Promise<PgClient | null> {
  try {
    // pg is a peer dependency — user must install it
    const pg = await (Function('return import("pg")')() as Promise<any>);
    const Pool = pg.default?.Pool || pg.Pool;
    const pool = new Pool({ connectionString });
    await pool.query("SELECT 1");
    return pool;
  } catch {
    return null;
  }
}

const CREATE_TABLE_SQL = (table: string) => `
  CREATE TABLE IF NOT EXISTS ${table} (
    id SERIAL PRIMARY KEY,
    task_id VARCHAR(255) NOT NULL,
    template VARCHAR(255) NOT NULL,
    model VARCHAR(100) NOT NULL,
    project VARCHAR(255),
    prompt TEXT,
    success BOOLEAN NOT NULL,
    iterations INTEGER DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ DEFAULT NOW(),
    duration_ms INTEGER,
    error TEXT,
    result TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_${table}_task_id ON ${table}(task_id);
  CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${table}(project);
  CREATE INDEX IF NOT EXISTS idx_${table}_completed_at ON ${table}(completed_at);
`;

const INSERT_SQL = (table: string) => `
  INSERT INTO ${table} (task_id, template, model, project, prompt, success, iterations, started_at, completed_at, duration_ms, error, result, metadata)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
`;

// Track start times
const taskStartTimes = new Map<string, number>();

// ── Plugin Entry Point ──────────────────────────────────────────────

export default function postgresPlugin(ctx: PluginContext, options: Record<string, unknown>): void {
  const config: PostgresConfig = { ...DEFAULTS, ...options } as PostgresConfig;
  config.connectionString = config.connectionString || process.env.TASKSMITH_PG_URL || process.env.DATABASE_URL || "";

  if (!config.connectionString) {
    ctx.log.warn("Postgres plugin requires connectionString. Set TASKSMITH_PG_URL or DATABASE_URL env var.");
    return;
  }

  let db: PgClient | null = null;

  ctx.addHook("onStartup", async () => {
    db = await createClient(config.connectionString);
    if (!db) {
      ctx.log.error("Failed to connect to PostgreSQL. Is 'pg' installed? (npm install pg)");
      return;
    }

    if (config.autoMigrate) {
      try {
        await db.query(CREATE_TABLE_SQL(config.tableName));
        ctx.log.info("Database tables ready");
      } catch (e: any) {
        ctx.log.error(`Migration failed: ${e.message}`);
      }
    }

    ctx.log.info(`Connected to PostgreSQL (table: ${config.tableName})`);
  });

  ctx.addHook("beforeTaskExecute", async (data) => {
    const task = data.task as Record<string, unknown> | undefined;
    if (task?.id) taskStartTimes.set(task.id as string, Date.now());
  });

  ctx.addHook("afterTaskExecute", async (data) => {
    if (!db) return;

    const task = data.task as Record<string, unknown> | undefined;
    const ok = data.ok as boolean;
    if (!task?.id) return;

    const taskId = task.id as string;
    const startTime = taskStartTimes.get(taskId) || Date.now();
    taskStartTimes.delete(taskId);
    const now = Date.now();

    try {
      await db.query(INSERT_SQL(config.tableName), [
        taskId,
        task.template || "unknown",
        task.model || "unknown",
        task.project || null,
        (task.prompt as string || "").slice(0, 5000),
        ok,
        task.iterations || 0,
        new Date(startTime).toISOString(),
        new Date(now).toISOString(),
        now - startTime,
        ok ? null : (task.error as string || "").slice(0, 5000),
        ok ? (task.result as string || "").slice(0, 5000) : null,
        JSON.stringify({ priority: task.priority, maxIterations: task.maxIterations }),
      ]);
    } catch (e: any) {
      ctx.log.error(`Failed to record task: ${e.message}`);
    }
  });

  ctx.addHook("onShutdown", async () => {
    if (db) {
      await db.end();
      ctx.log.info("Disconnected from PostgreSQL");
    }
  });

  // CLI command: tasksmith pg
  ctx.addCommand("pg", {
    description: "Query PostgreSQL task history",
    options: [
      { flag: "--last <n>", description: "Show last N tasks", default: "10" },
      { flag: "--project <name>", description: "Filter by project" },
      { flag: "--failures", description: "Show only failures" },
    ],
    action: async (args) => {
      const chalk = (await import("chalk")).default;
      const client = await createClient(config.connectionString);
      if (!client) {
        console.log(chalk.red("\n  Cannot connect to PostgreSQL.\n"));
        return;
      }

      const conditions: string[] = [];
      const values: unknown[] = [];
      let paramIdx = 1;

      if (args.project) {
        conditions.push(`project = $${paramIdx++}`);
        values.push(args.project);
      }
      if (args.failures) {
        conditions.push("success = false");
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = parseInt(args.last || "10") || 10;

      try {
        const result = await client.query(
          `SELECT task_id, template, model, project, success, iterations, duration_ms, completed_at, error FROM ${config.tableName} ${where} ORDER BY completed_at DESC LIMIT ${limit}`,
          values,
        );

        console.log(chalk.bold(`\n  Task History (last ${limit})\n`));
        for (const row of result.rows) {
          const icon = row.success ? chalk.green("✓") : chalk.red("✗");
          const dur = Math.round((row.duration_ms as number) / 1000);
          console.log(`    ${icon} ${(row.task_id as string).slice(0, 30).padEnd(32)} ${(row.template as string).padEnd(16)} ${(row.model as string).padEnd(8)} ${String(row.iterations).padStart(2)} iters  ${String(dur).padStart(4)}s  ${row.project || ""}`);
          if (!row.success && row.error) {
            console.log(`      ${chalk.dim((row.error as string).slice(0, 80))}`);
          }
        }

        // Summary
        const summary = await client.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE success) as passed FROM ${config.tableName} ${where}`, values);
        const s = summary.rows[0];
        const total = Number(s.total);
        const passed = Number(s.passed);
        const rate = total > 0 ? Math.round((passed / total) * 100) : 0;
        console.log(chalk.bold(`\n  Summary: ${total} tasks, ${passed} passed, ${rate}% success rate\n`));
      } catch (e: any) {
        console.log(chalk.red(`\n  Query failed: ${e.message}\n`));
      }

      await client.end();
    },
  });
}

export { PostgresConfig };
