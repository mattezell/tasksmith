/**
 * TaskSmith Official Plugin: JIRA
 *
 * Integrates task lifecycle with Atlassian JIRA.
 *
 * Features:
 *   - Auto-create JIRA tickets from failed tasks
 *   - Transition tickets when linked tasks complete
 *   - Comment task results on linked tickets
 *   - Map TaskSmith priority → JIRA priority
 *
 * Config:
 *   plugins:
 *     - name: jira
 *       config:
 *         host: "https://yourteam.atlassian.net"
 *         email: "you@company.com"
 *         apiToken: ""                  # or JIRA_API_TOKEN env var
 *         projectKey: "PROJ"            # default JIRA project
 *         issueType: "Task"             # default issue type
 *         createOnFailure: true
 *         transitionOnSuccess: true     # move to "Done" on task success
 *         doneTransitionName: "Done"    # name of the "done" transition
 *         labels: ["tasksmith"]
 *
 * Task-level link:
 *   params:
 *     jira_ticket: "PROJ-123"
 */

import type { ForgePluginContext } from "../../plugins.js";
import type { Notification, OutboundCommsProvider } from "../../types.js";

interface JiraConfig {
  host: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType: string;
  createOnFailure: boolean;
  transitionOnSuccess: boolean;
  doneTransitionName: string;
  labels: string[];
}

const DEFAULTS: JiraConfig = {
  host: "",
  email: "",
  apiToken: "",
  projectKey: "",
  issueType: "Task",
  createOnFailure: true,
  transitionOnSuccess: true,
  doneTransitionName: "Done",
  labels: ["tasksmith"],
};

// ── JIRA API Client ─────────────────────────────────────────────────

class JiraAPI {
  constructor(
    private host: string,
    private email: string,
    private token: string,
  ) {}

  private get headers(): Record<string, string> {
    const auth = Buffer.from(`${this.email}:${this.token}`).toString("base64");
    return {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  async createIssue(projectKey: string, summary: string, description: string, issueType: string, labels: string[]): Promise<{ key: string; self: string } | null> {
    try {
      const res = await fetch(`${this.host}/rest/api/3/issue`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            summary,
            description: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
            },
            issuetype: { name: issueType },
            labels,
          },
        }),
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      return { key: data.key, self: data.self };
    } catch {
      return null;
    }
  }

  async addComment(issueKey: string, body: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.host}/rest/api/3/issue/${issueKey}/comment`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          body: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
          },
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getTransitions(issueKey: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const res = await fetch(`${this.host}/rest/api/3/issue/${issueKey}/transitions`, { headers: this.headers });
      if (!res.ok) return [];
      const data = await res.json() as any;
      return (data.transitions || []).map((t: any) => ({ id: t.id, name: t.name }));
    } catch {
      return [];
    }
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.host}/rest/api/3/issue/${issueKey}/transitions`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ transition: { id: transitionId } }),
      });
      return res.ok || res.status === 204;
    } catch {
      return false;
    }
  }

  async test(): Promise<boolean> {
    try {
      const res = await fetch(`${this.host}/rest/api/3/myself`, { headers: this.headers, signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ── JIRA Outbound Provider ──────────────────────────────────────────

class JiraOutboundProvider implements OutboundCommsProvider {
  readonly name = "jira";
  constructor(private api: JiraAPI, private config: JiraConfig) {}

  async send(notification: Notification): Promise<boolean> {
    const issue = await this.api.createIssue(
      this.config.projectKey,
      notification.title,
      notification.body,
      this.config.issueType,
      this.config.labels,
    );
    return issue !== null;
  }

  async test(): Promise<boolean> {
    return this.api.test();
  }
}

// ── Plugin Entry Point ──────────────────────────────────────────────

export default function jiraPlugin(ctx: ForgePluginContext, options: Record<string, unknown>): void {
  const config: JiraConfig = { ...DEFAULTS, ...options } as JiraConfig;
  config.apiToken = config.apiToken || process.env.JIRA_API_TOKEN || "";

  if (!config.host || !config.email || !config.apiToken || !config.projectKey) {
    ctx.log.warn("JIRA plugin requires host, email, apiToken, and projectKey.");
    return;
  }

  const api = new JiraAPI(config.host, config.email, config.apiToken);
  ctx.addOutboundProvider(new JiraOutboundProvider(api, config));

  // Auto-create tickets on failure
  if (config.createOnFailure) {
    ctx.addHook("afterTaskExecute", async (data) => {
      const task = data.task as Record<string, unknown> | undefined;
      const ok = data.ok as boolean | undefined;
      if (!ok && task) {
        const summary = `[TaskSmith] Failed: ${task.template} (${task.id})`;
        const description = [
          `Prompt: ${(task.prompt as string || "").slice(0, 500)}`,
          `Project: ${task.project || "none"}`,
          `Model: ${task.model || "unknown"}`,
          `Iterations: ${task.iterations || 0}`,
          `Error: ${(task.error as string || "unknown").slice(0, 2000)}`,
        ].join("\n");
        const issue = await api.createIssue(config.projectKey, summary, description, config.issueType, [...config.labels, "bug"]);
        if (issue) ctx.log.info(`Created JIRA ticket: ${issue.key}`);
      }
    });
  }

  // Transition linked tickets on success
  if (config.transitionOnSuccess) {
    ctx.addHook("afterTaskExecute", async (data) => {
      const task = data.task as Record<string, unknown> | undefined;
      const ok = data.ok as boolean | undefined;
      const params = task?.params as Record<string, unknown> | undefined;
      const ticketKey = params?.jira_ticket as string | undefined;

      if (ok && ticketKey) {
        // Comment first
        await api.addComment(ticketKey, [
          `✅ Task completed successfully`,
          `Task: ${task?.id}`,
          `Template: ${task?.template}`,
          `Iterations: ${task?.iterations || 0}`,
        ].join("\n"));

        // Find and execute "Done" transition
        const transitions = await api.getTransitions(ticketKey);
        const done = transitions.find(t => t.name.toLowerCase() === config.doneTransitionName.toLowerCase());
        if (done) {
          await api.transitionIssue(ticketKey, done.id);
          ctx.log.info(`Transitioned ${ticketKey} → ${config.doneTransitionName}`);
        }
      }
    });
  }

  ctx.log.info(`JIRA integration active (${config.host}, project: ${config.projectKey})`);
}

export { JiraAPI, JiraConfig };
