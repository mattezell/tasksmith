/**
 * TaskSmith Official Plugin: Cloudflare
 *
 * Deploy to Cloudflare Pages, manage DNS, and more.
 * Uses wrangler CLI for Pages deployments (official supported path)
 * and Cloudflare REST API for project/deployment info.
 *
 * Features:
 *   - Deploy to Cloudflare Pages on task success (auto or manual)
 *   - Preview deployments on branches
 *   - List deployments and their status
 *   - Rollback to previous deployments
 *   - Purge CDN cache after deploy
 *   - CLI commands: tasksmith cf deploy, tasksmith cf status, tasksmith cf rollback
 *
 * Config:
 *   plugins:
 *     - name: cloudflare
 *       config:
 *         accountId: ""               # or CLOUDFLARE_ACCOUNT_ID env
 *         apiToken: ""                # or CLOUDFLARE_API_TOKEN env
 *         pages:
 *           projectName: "tasksmith"  # Pages project name
 *           deployDir: "site/"        # directory to deploy
 *           branch: "main"            # production branch
 *           autoDeployOnSuccess: false # deploy after successful tasks
 *           autoDeployPattern: "site/" # only auto-deploy if task touched these paths
 *         purgeCache:
 *           enabled: false
 *           zoneId: ""                # or CLOUDFLARE_ZONE_ID env
 *
 * Task-level override:
 *   params:
 *     cf_deploy: true                 # force deploy after this task
 *     cf_deploy_dir: "dist/"          # override deploy directory
 *     cf_branch: "preview"            # deploy to preview branch
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ForgePluginContext } from "../../plugins.js";

interface CloudflarePagesConfig {
  projectName: string;
  deployDir: string;
  branch: string;
  autoDeployOnSuccess: boolean;
  autoDeployPattern: string;
}

interface CloudflarePurgeCacheConfig {
  enabled: boolean;
  zoneId: string;
}

interface CloudflareConfig {
  accountId: string;
  apiToken: string;
  pages: CloudflarePagesConfig;
  purgeCache: CloudflarePurgeCacheConfig;
}

const DEFAULTS: CloudflareConfig = {
  accountId: "",
  apiToken: "",
  pages: {
    projectName: "",
    deployDir: "site/",
    branch: "main",
    autoDeployOnSuccess: false,
    autoDeployPattern: "",
  },
  purgeCache: {
    enabled: false,
    zoneId: "",
  },
};

// ── Cloudflare REST API ─────────────────────────────────────────────

class CloudflareAPI {
  private baseUrl = "https://api.cloudflare.com/client/v4";

  constructor(
    private accountId: string,
    private apiToken: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  async test(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/user/tokens/verify`, {
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const data = await res.json() as any;
      return data.success === true;
    } catch {
      return false;
    }
  }

  async getProject(projectName: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/accounts/${this.accountId}/pages/projects/${projectName}`,
        { headers: this.headers },
      );
      if (!res.ok) return null;
      const data = await res.json() as any;
      return data.result || null;
    } catch {
      return null;
    }
  }

  async listDeployments(projectName: string, limit = 10): Promise<Array<Record<string, unknown>>> {
    try {
      const res = await fetch(
        `${this.baseUrl}/accounts/${this.accountId}/pages/projects/${projectName}/deployments?per_page=${limit}`,
        { headers: this.headers },
      );
      if (!res.ok) return [];
      const data = await res.json() as any;
      return data.result || [];
    } catch {
      return [];
    }
  }

  async getDeployment(projectName: string, deploymentId: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/accounts/${this.accountId}/pages/projects/${projectName}/deployments/${deploymentId}`,
        { headers: this.headers },
      );
      if (!res.ok) return null;
      const data = await res.json() as any;
      return data.result || null;
    } catch {
      return null;
    }
  }

  async rollbackDeployment(projectName: string, deploymentId: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.baseUrl}/accounts/${this.accountId}/pages/projects/${projectName}/deployments/${deploymentId}/rollback`,
        { method: "POST", headers: this.headers },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async purgeCache(zoneId: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.baseUrl}/zones/${zoneId}/purge_cache`,
        {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({ purge_everything: true }),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ── Wrangler Deploy ─────────────────────────────────────────────────

function isWranglerAvailable(): boolean {
  const result = spawnSync("npx", ["wrangler", "--version"], {
    timeout: 15000,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return result.status === 0;
}

interface DeployResult {
  success: boolean;
  url?: string;
  deploymentId?: string;
  error?: string;
}

function deployPages(
  deployDir: string,
  projectName: string,
  branch: string,
  accountId: string,
  apiToken: string,
): DeployResult {
  const absDir = resolve(deployDir);
  if (!existsSync(absDir)) {
    return { success: false, error: `Deploy directory not found: ${absDir}` };
  }

  const env = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: apiToken,
  };

  const args = [
    "wrangler", "pages", "deploy", absDir,
    "--project-name", projectName,
    "--branch", branch,
  ];

  const result = spawnSync("npx", args, {
    encoding: "utf-8",
    timeout: 120000,
    env,
    stdio: "pipe",
  });

  if (result.status === 0) {
    // Parse deployment URL from wrangler output
    const output = result.stdout + result.stderr;
    const urlMatch = output.match(/https:\/\/[^\s]+\.pages\.dev/);
    const idMatch = output.match(/Deployment ID:\s*([a-f0-9-]+)/i) ||
                    output.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);

    return {
      success: true,
      url: urlMatch?.[0] || `https://${projectName}.pages.dev`,
      deploymentId: idMatch?.[1],
    };
  } else {
    return {
      success: false,
      error: (result.stderr || result.stdout || "Unknown error").trim().slice(0, 500),
    };
  }
}

// ── Plugin Entry Point ──────────────────────────────────────────────

export default function cloudflarePlugin(ctx: ForgePluginContext, options: Record<string, unknown>): void {
  const config: CloudflareConfig = {
    ...DEFAULTS,
    ...options,
    pages: { ...DEFAULTS.pages, ...((options.pages as Record<string, unknown>) || {}) } as CloudflarePagesConfig,
    purgeCache: { ...DEFAULTS.purgeCache, ...((options.purgeCache as Record<string, unknown>) || {}) } as CloudflarePurgeCacheConfig,
  };

  config.accountId = config.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || "";
  config.apiToken = config.apiToken || process.env.CLOUDFLARE_API_TOKEN || "";
  config.purgeCache.zoneId = config.purgeCache.zoneId || process.env.CLOUDFLARE_ZONE_ID || "";

  if (!config.accountId || !config.apiToken) {
    ctx.log.warn("Cloudflare plugin requires accountId and apiToken. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars.");
    return;
  }

  const api = new CloudflareAPI(config.accountId, config.apiToken);

  // Verify on startup
  ctx.addHook("onStartup", async () => {
    const ok = await api.test();
    if (ok) {
      ctx.log.info(`Connected to Cloudflare (project: ${config.pages.projectName || "(not set)"})`);
    } else {
      ctx.log.error("Cloudflare API token verification failed");
    }

    if (!isWranglerAvailable()) {
      ctx.log.warn("wrangler not found. Install with: npm install -g wrangler");
    }
  });

  // Auto-deploy on task success
  if (config.pages.autoDeployOnSuccess && config.pages.projectName) {
    ctx.addHook("afterTaskExecute", async (data) => {
      const task = data.task as Record<string, unknown> | undefined;
      const ok = data.ok as boolean;
      if (!ok || !task) return;

      // Check if task should trigger a deploy
      const params = task.params as Record<string, unknown> | undefined;
      const forceDeploy = params?.cf_deploy === true;
      const prompt = (task.prompt as string) || "";

      // Deploy if forced, or if autoDeployPattern matches the task prompt
      const shouldDeploy = forceDeploy ||
        (config.pages.autoDeployPattern && prompt.toLowerCase().includes(config.pages.autoDeployPattern.toLowerCase()));

      if (!shouldDeploy) return;

      const deployDir = (params?.cf_deploy_dir as string) || config.pages.deployDir;
      const branch = (params?.cf_branch as string) || config.pages.branch;

      ctx.log.info(`Deploying to Cloudflare Pages (${config.pages.projectName}, branch: ${branch})...`);

      const result = deployPages(
        resolve(ctx.workspace, deployDir),
        config.pages.projectName,
        branch,
        config.accountId,
        config.apiToken,
      );

      if (result.success) {
        ctx.log.info(`Deployed: ${result.url}`);

        // Purge cache if enabled
        if (config.purgeCache.enabled && config.purgeCache.zoneId) {
          const purged = await api.purgeCache(config.purgeCache.zoneId);
          ctx.log.info(purged ? "CDN cache purged" : "Cache purge failed");
        }
      } else {
        ctx.log.error(`Deploy failed: ${result.error}`);
      }
    });
  }

  // CLI: tasksmith cf deploy
  ctx.addCommand("cf", {
    description: "Cloudflare Pages: deploy, status, rollback",
    options: [
      { flag: "--action <action>", description: "deploy, status, deployments, rollback", default: "status" },
      { flag: "--dir <dir>", description: "Deploy directory (overrides config)" },
      { flag: "--branch <branch>", description: "Branch name (default: production)" },
      { flag: "--deployment-id <id>", description: "Deployment ID (for rollback)" },
    ],
    action: async (args) => {
      const chalk = (await import("chalk")).default;
      const action = args.action || "status";

      switch (action) {
        case "deploy": {
          if (!config.pages.projectName) {
            console.log(chalk.red("\n  No pages.projectName configured.\n"));
            return;
          }

          if (!isWranglerAvailable()) {
            console.log(chalk.red("\n  wrangler not found. Install: npm install -g wrangler\n"));
            return;
          }

          const deployDir = args.dir || config.pages.deployDir;
          const branch = args.branch || config.pages.branch;
          const absDir = resolve(ctx.workspace, deployDir);

          console.log(chalk.bold("\n  Deploying to Cloudflare Pages\n"));
          console.log(`    Project:   ${config.pages.projectName}`);
          console.log(`    Directory: ${absDir}`);
          console.log(`    Branch:    ${branch}`);
          console.log();

          const result = deployPages(absDir, config.pages.projectName, branch, config.accountId, config.apiToken);

          if (result.success) {
            console.log(`  ${chalk.green("✓")} Deployed: ${chalk.bold(result.url)}`);
            if (result.deploymentId) {
              console.log(`    Deployment ID: ${chalk.dim(result.deploymentId)}`);
            }

            if (config.purgeCache.enabled && config.purgeCache.zoneId) {
              const purged = await api.purgeCache(config.purgeCache.zoneId);
              console.log(purged
                ? `  ${chalk.green("✓")} CDN cache purged`
                : `  ${chalk.yellow("!")} Cache purge failed`);
            }
          } else {
            console.log(`  ${chalk.red("✗")} Deploy failed: ${result.error}`);
          }
          console.log();
          break;
        }

        case "status": {
          console.log(chalk.bold("\n  Cloudflare Plugin Status\n"));

          const tokenOk = await api.test();
          console.log(`    API Token:   ${tokenOk ? chalk.green("valid") : chalk.red("invalid")}`);
          console.log(`    Account ID:  ${config.accountId.slice(0, 8)}...`);
          console.log(`    Wrangler:    ${isWranglerAvailable() ? chalk.green("available") : chalk.red("not found")}`);

          if (config.pages.projectName) {
            const project = await api.getProject(config.pages.projectName);
            if (project) {
              const domains = (project.domains as string[]) || [];
              const subdomain = project.subdomain as string || "";
              console.log(`\n    Pages Project: ${chalk.bold(config.pages.projectName)}`);
              console.log(`    URL:           https://${subdomain}.pages.dev`);
              if (domains.length > 0) {
                console.log(`    Domains:       ${domains.join(", ")}`);
              }
              console.log(`    Deploy Dir:    ${config.pages.deployDir}`);
              console.log(`    Branch:        ${config.pages.branch}`);
              console.log(`    Auto-deploy:   ${config.pages.autoDeployOnSuccess ? chalk.green("on") : chalk.dim("off")}`);

              // Latest deployment
              const deployments = await api.listDeployments(config.pages.projectName, 1);
              if (deployments.length > 0) {
                const d = deployments[0];
                const env = (d.environment as string) || "production";
                const created = new Date(d.created_on as string).toLocaleString();
                console.log(`\n    Latest Deploy: ${chalk.dim(created)} (${env})`);
                console.log(`    URL:           ${d.url || "n/a"}`);
              }
            } else {
              console.log(`\n    Pages Project: ${chalk.red("not found")} (${config.pages.projectName})`);
            }
          } else {
            console.log(chalk.dim("\n    No pages.projectName configured."));
          }

          if (config.purgeCache.enabled) {
            console.log(`\n    Cache Purge:   ${chalk.green("enabled")} (zone: ${config.purgeCache.zoneId.slice(0, 8)}...)`);
          }

          console.log();
          break;
        }

        case "deployments": {
          if (!config.pages.projectName) {
            console.log(chalk.red("\n  No pages.projectName configured.\n"));
            return;
          }

          const deployments = await api.listDeployments(config.pages.projectName, 10);
          console.log(chalk.bold(`\n  Recent Deployments: ${config.pages.projectName}\n`));

          if (deployments.length === 0) {
            console.log(chalk.dim("    No deployments found.\n"));
            return;
          }

          for (const d of deployments) {
            const env = (d.environment as string) || "?";
            const created = new Date(d.created_on as string).toLocaleString();
            const envColor = env === "production" ? chalk.green : chalk.yellow;
            const id = (d.id as string || "").slice(0, 8);
            console.log(`    ${envColor(env.padEnd(12))} ${chalk.dim(id)}  ${created}  ${d.url || ""}`);
          }
          console.log();
          break;
        }

        case "rollback": {
          const deploymentId = args["deployment-id"];
          if (!deploymentId || !config.pages.projectName) {
            console.log(chalk.red("\n  Usage: tasksmith cf --action rollback --deployment-id <id>\n"));
            if (config.pages.projectName) {
              console.log(chalk.dim("  Tip: use --action deployments to see available deployment IDs\n"));
            }
            return;
          }

          console.log(`\n  Rolling back to deployment ${chalk.bold(deploymentId)}...`);
          const ok = await api.rollbackDeployment(config.pages.projectName, deploymentId);
          console.log(ok
            ? `  ${chalk.green("✓")} Rollback successful`
            : `  ${chalk.red("✗")} Rollback failed`);
          console.log();
          break;
        }

        default:
          console.log(chalk.red(`\n  Unknown action: ${action}`));
          console.log(chalk.dim("  Available: deploy, status, deployments, rollback\n"));
      }
    },
  });

  ctx.log.info(`Cloudflare integration active (project: ${config.pages.projectName || "(not set)"})`);
}

export { CloudflareAPI, CloudflareConfig, DeployResult };
