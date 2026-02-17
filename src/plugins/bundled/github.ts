/**
 * TaskSmith Official Plugin: GitHub
 *
 * Integrates task lifecycle with GitHub Issues and Pull Requests.
 *
 * Features:
 *   - Auto-create issues from failed tasks
 *   - Comment on existing issues with task results
 *   - Close issues when linked tasks complete successfully
 *   - Create summary comments on PRs after task execution
 *   - Outbound notifications via GitHub Issues
 *
 * Config:
 *   plugins:
 *     - name: github
 *       config:
 *         token: "ghp_..."                # or GITHUB_TOKEN env var
 *         owner: "mattezell"              # repo owner
 *         repo: "tasksmith"               # repo name
 *         createIssuesOnFailure: true     # auto-create issues for failed tasks
 *         closeIssuesOnSuccess: true      # close linked issues on task success
 *         commentOnIssues: true           # comment task results on linked issues
 *         labels: ["tasksmith", "automated"]
 */

import type { ForgePluginContext } from "../../plugins.js";
import type { Notification, OutboundCommsProvider } from "../../types.js";

interface GitHubPluginConfig {
  token: string;
  owner: string;
  repo: string;
  createIssuesOnFailure: boolean;
  closeIssuesOnSuccess: boolean;
  commentOnIssues: boolean;
  labels: string[];
}

const DEFAULTS: GitHubPluginConfig = {
  token: "",
  owner: "",
  repo: "",
  createIssuesOnFailure: true,
  closeIssuesOnSuccess: true,
  commentOnIssues: true,
  labels: ["tasksmith", "automated"],
};

// ── GitHub API Client ───────────────────────────────────────────────

class GitHubAPI {
  private baseUrl = "https://api.github.com";

  constructor(
    private token: string,
    private owner: string,
    private repo: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  private get repoUrl(): string {
    return `${this.baseUrl}/repos/${this.owner}/${this.repo}`;
  }

  async createIssue(title: string, body: string, labels: string[] = []): Promise<{ number: number; html_url: string } | null> {
    try {
      const res = await fetch(`${this.repoUrl}/issues`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ title, body, labels }),
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      return { number: data.number, html_url: data.html_url };
    } catch {
      return null;
    }
  }

  async commentOnIssue(issueNumber: number, body: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.repoUrl}/issues/${issueNumber}/comments`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ body }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async closeIssue(issueNumber: number): Promise<boolean> {
    try {
      const res = await fetch(`${this.repoUrl}/issues/${issueNumber}`, {
        method: "PATCH",
        headers: this.headers,
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async test(): Promise<boolean> {
    try {
      const res = await fetch(this.repoUrl, { headers: this.headers, signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ── GitHub Outbound Provider ────────────────────────────────────────

class GitHubOutboundProvider implements OutboundCommsProvider {
  readonly name = "github";
  private api: GitHubAPI;
  private config: GitHubPluginConfig;

  constructor(api: GitHubAPI, config: GitHubPluginConfig) {
    this.api = api;
    this.config = config;
  }

  async send(notification: Notification): Promise<boolean> {
    // Create a GitHub issue for task notifications
    const issue = await this.api.createIssue(
      notification.title,
      this.formatBody(notification),
      this.config.labels,
    );
    return issue !== null;
  }

  async test(): Promise<boolean> {
    return this.api.test();
  }

  private formatBody(n: Notification): string {
    const parts = [`${n.body}`];
    if (n.taskId) parts.push(`\n**Task ID:** \`${n.taskId}\``);
    if (n.metadata) {
      const meta = n.metadata as Record<string, unknown>;
      if (meta.iterations) parts.push(`**Iterations:** ${meta.iterations}`);
      if (meta.model) parts.push(`**Model:** ${meta.model}`);
      if (meta.duration) parts.push(`**Duration:** ${meta.duration}`);
    }
    parts.push("\n---\n*Created by [TaskSmith](https://tasksmith.dev)*");
    return parts.join("\n");
  }
}

// ── Plugin Entry Point ──────────────────────────────────────────────

export default function githubPlugin(ctx: ForgePluginContext, options: Record<string, unknown>): void {
  const config: GitHubPluginConfig = { ...DEFAULTS, ...options } as GitHubPluginConfig;

  // Allow env var override for token
  config.token = config.token || process.env.GITHUB_TOKEN || "";

  if (!config.token || !config.owner || !config.repo) {
    ctx.log.warn("GitHub plugin requires token, owner, and repo. Set GITHUB_TOKEN env var or configure in tasksmith.yaml.");
    return;
  }

  const api = new GitHubAPI(config.token, config.owner, config.repo);

  // Register as outbound notification provider
  ctx.addOutboundProvider(new GitHubOutboundProvider(api, config));

  // Hook: create issues on task failure
  if (config.createIssuesOnFailure) {
    ctx.addHook("afterTaskExecute", async (data) => {
      const task = data.task as Record<string, unknown> | undefined;
      const ok = data.ok as boolean | undefined;
      if (!ok && task) {
        const title = `❌ Task failed: ${task.template} (${task.id})`;
        const body = [
          `**Prompt:** ${(task.prompt as string || "").slice(0, 500)}`,
          `**Project:** ${task.project || "none"}`,
          `**Model:** ${task.model || "unknown"}`,
          `**Iterations:** ${task.iterations || 0}`,
          `**Error:**\n\`\`\`\n${(task.error as string || "unknown").slice(0, 2000)}\n\`\`\``,
          "",
          "---",
          "*Auto-created by [TaskSmith](https://tasksmith.dev)*",
        ].join("\n");
        const issue = await api.createIssue(title, body, [...config.labels, "bug"]);
        if (issue) {
          ctx.log.info(`Created issue #${issue.number}: ${issue.html_url}`);
        }
      }
    });
  }

  // Hook: comment/close issues when linked tasks succeed
  if (config.closeIssuesOnSuccess || config.commentOnIssues) {
    ctx.addHook("afterTaskExecute", async (data) => {
      const task = data.task as Record<string, unknown> | undefined;
      const ok = data.ok as boolean | undefined;
      const params = task?.params as Record<string, unknown> | undefined;
      const issueNumber = params?.github_issue as number | undefined;

      if (ok && issueNumber) {
        if (config.commentOnIssues) {
          await api.commentOnIssue(issueNumber, [
            `✅ **Task completed successfully**`,
            "",
            `**Task:** \`${task?.id}\``,
            `**Template:** ${task?.template}`,
            `**Iterations:** ${task?.iterations || 0}`,
            `**Result:** ${((task?.result as string) || "").slice(0, 1000)}`,
            "",
            "---",
            "*Auto-comment by [TaskSmith](https://tasksmith.dev)*",
          ].join("\n"));
        }
        if (config.closeIssuesOnSuccess) {
          await api.closeIssue(issueNumber);
          ctx.log.info(`Closed issue #${issueNumber}`);
        }
      }
    });
  }

  ctx.log.info(`GitHub integration active (${config.owner}/${config.repo})`);
}

export { GitHubAPI, GitHubOutboundProvider, GitHubPluginConfig };
