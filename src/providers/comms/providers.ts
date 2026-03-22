/**
 * Communication Providers
 *
 * Outbound: send notifications to the user.
 * Inbound: receive commands from the user.
 */

import { watch } from "chokidar";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import yaml from "js-yaml";
import type {
  OutboundCommsProvider,
  InboundCommsProvider,
  Notification,
  InboundMessage,
  InboundCallback,
  Priority,
} from "../../types.js";

// =============================================================================
// OUTBOUND
// =============================================================================

export class DiscordWebhookProvider implements OutboundCommsProvider {
  readonly name = "discord_webhook";
  private webhookUrl: string;
  private username: string;

  constructor(config: Record<string, unknown>) {
    this.webhookUrl = (config.webhookUrl as string) || "";
    this.username = (config.username as string) || "TaskSmith";
  }

  async send(n: Notification): Promise<boolean> {
    const colorMap: Record<string, number> = { low: 0x808080, normal: 0x3498db, high: 0xf1c40f, urgent: 0xe74c3c };
    const embed: Record<string, unknown> = {
      title: n.title,
      description: n.body.slice(0, 4096),
      color: colorMap[n.priority] ?? 0x3498db,
      timestamp: new Date().toISOString(),
    };
    if (n.taskId) embed.footer = { text: `Task: ${n.taskId}` };

    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: this.username, embeds: [embed] }),
      });
      return res.status === 200 || res.status === 204;
    } catch (e) {
      console.error(`[discord_webhook] ${e}`);
      return false;
    }
  }

  async test(): Promise<boolean> {
    return this.send({ title: "TaskSmith Connected", body: "Notifications are working.", priority: "normal" as Priority });
  }
}

export class NtfyProvider implements OutboundCommsProvider {
  readonly name = "ntfy";
  private server: string;
  private topic: string;

  constructor(config: Record<string, unknown>) {
    this.server = ((config.server as string) || "https://ntfy.sh").replace(/\/+$/, "");
    this.topic = (config.topic as string) || "tasksmith";
  }

  async send(n: Notification): Promise<boolean> {
    const prioMap: Record<string, string> = { low: "2", normal: "3", high: "4", urgent: "5" };
    try {
      const res = await fetch(`${this.server}/${this.topic}`, {
        method: "POST",
        body: n.body,
        headers: { Title: n.title, Priority: prioMap[n.priority] ?? "3", Tags: "robot" },
      });
      return res.status === 200;
    } catch (e) {
      console.error(`[ntfy] ${e}`);
      return false;
    }
  }

  async test(): Promise<boolean> {
    return this.send({ title: "TaskSmith", body: "Push notifications working.", priority: "normal" as Priority });
  }
}

export class SlackWebhookProvider implements OutboundCommsProvider {
  readonly name = "slack_webhook";
  private webhookUrl: string;

  constructor(config: Record<string, unknown>) {
    this.webhookUrl = (config.webhookUrl as string) || "";
  }

  async send(n: Notification): Promise<boolean> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `*${n.title}*\n${n.body}` }),
      });
      return res.status === 200;
    } catch (e) {
      console.error(`[slack] ${e}`);
      return false;
    }
  }

  async test(): Promise<boolean> {
    return this.send({ title: "TaskSmith", body: "Slack connected.", priority: "normal" as Priority });
  }
}

export class EmailProvider implements OutboundCommsProvider {
  readonly name = "email";
  private config: Record<string, unknown>;
  private transporter: any = null;

  constructor(config: Record<string, unknown>) {
    this.config = config;
  }

  private async getTransporter(): Promise<any> {
    if (this.transporter) return this.transporter;
    try {
      // Dynamic import with variable to prevent TypeScript from resolving at compile time.
      // nodemailer is an optional dependency — users install it only if they need email.
      const pkg = "nodemailer";
      const nodemailer = await import(pkg);
      this.transporter = (nodemailer.default ?? nodemailer).createTransport({
        host: this.config.smtpHost as string,
        port: (this.config.smtpPort as number) || 587,
        secure: (this.config.smtpPort as number) === 465,
        auth: {
          user: this.config.smtpUser as string,
          pass: this.config.smtpPass as string,
        },
      });
      return this.transporter;
    } catch {
      return null;
    }
  }

  async send(n: Notification): Promise<boolean> {
    const transport = await this.getTransporter();
    if (!transport) {
      console.warn("[email] nodemailer not installed. Run: npm install nodemailer");
      return false;
    }
    try {
      await transport.sendMail({
        from: this.config.fromAddr as string,
        to: this.config.toAddr as string,
        subject: `[TaskSmith] ${n.title}`,
        text: n.body,
      });
      return true;
    } catch (e: any) {
      console.error(`[email] Send failed: ${e.message}`);
      return false;
    }
  }

  async test(): Promise<boolean> {
    const transport = await this.getTransporter();
    if (!transport) {
      console.warn("[email] nodemailer not installed. Run: npm install nodemailer");
      return false;
    }
    try {
      await transport.verify();
      return true;
    } catch {
      return false;
    }
  }
}

export class GenericWebhookProvider implements OutboundCommsProvider {
  readonly name = "webhook_generic";
  private url: string;
  private method: string;
  private headers: Record<string, string>;

  constructor(config: Record<string, unknown>) {
    this.url = (config.url as string) || "";
    this.method = (config.method as string) || "POST";
    this.headers = (config.headers as Record<string, string>) || {};
  }

  async send(n: Notification): Promise<boolean> {
    try {
      const res = await fetch(this.url, {
        method: this.method,
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify({ title: n.title, body: n.body, priority: n.priority, taskId: n.taskId, ts: new Date().toISOString() }),
      });
      return res.status < 400;
    } catch (e) {
      console.error(`[webhook] ${e}`);
      return false;
    }
  }

  async test(): Promise<boolean> {
    return this.send({ title: "test", body: "test", priority: "normal" as Priority });
  }
}

// =============================================================================
// INBOUND
// =============================================================================

export class FileDropProvider implements InboundCommsProvider {
  readonly name = "file_drop";
  private inboxPath: string;
  private watcher: ReturnType<typeof watch> | null = null;

  /**
   * Tracks recently processed file paths to prevent duplicate processing.
   * WSL2's inotify implementation fires multiple 'add' events for a single
   * file write. Without deduplication, each event creates a separate task.
   * Entries are cleared after DEDUP_WINDOW_MS to allow legitimate resubmissions.
   */
  private recentlyProcessed = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 2000;

  constructor(_config: Record<string, unknown>, inboxPath: string) {
    this.inboxPath = inboxPath;
  }

  async start(callback: InboundCallback): Promise<void> {
    // ignoreInitial: true — files already in the inbox at startup are handled
    // by the engine's scanInbox interval, not by the file watcher. This prevents
    // a race where both the watcher and scanInbox process the same file.
    this.watcher = watch(this.inboxPath, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 500 } });

    this.watcher.on("add", async (filePath: string) => {
      const fileName = basename(filePath);
      if (!fileName.endsWith(".yaml") && !fileName.endsWith(".yml") && !fileName.endsWith(".json")) return;
      // Skip claimed files (our own renames) to avoid retriggering
      if (fileName.startsWith(".")) return;

      // Deduplicate: skip if this exact path was processed within the window.
      // This guards against WSL2/inotify firing multiple events for one write.
      const now = Date.now();
      const lastSeen = this.recentlyProcessed.get(filePath);
      if (lastSeen && now - lastSeen < FileDropProvider.DEDUP_WINDOW_MS) {
        return;
      }
      this.recentlyProcessed.set(filePath, now);

      // Prune stale entries periodically to prevent unbounded growth
      if (this.recentlyProcessed.size > 100) {
        for (const [path, ts] of this.recentlyProcessed) {
          if (now - ts > FileDropProvider.DEDUP_WINDOW_MS) this.recentlyProcessed.delete(path);
        }
      }

      // Atomic claim: rename the file so scanInbox can't see it.
      // If rename fails (ENOENT), scanInbox already moved it — skip.
      const claimedPath = join(dirname(filePath), `.claimed-${fileName}`);
      try {
        renameSync(filePath, claimedPath);
      } catch {
        return; // File already moved by scanInbox — no duplicate
      }

      try {
        const content = readFileSync(claimedPath, "utf-8");
        await callback({
          source: "file_drop",
          sender: "local",
          content,
          timestamp: new Date(),
          metadata: { filePath: claimedPath },
        });
      } catch (e) {
        console.error(`[file_drop] Error processing ${filePath}: ${e}`);
      } finally {
        try { unlinkSync(claimedPath); } catch { /* already cleaned up */ }
      }
    });

    console.log(`[file_drop] Watching ${this.inboxPath}`);
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  async test(): Promise<boolean> {
    try {
      readdirSync(this.inboxPath);
      return true;
    } catch {
      return false;
    }
  }
}

export class DiscordBotProvider implements InboundCommsProvider {
  readonly name = "discord_bot";
  private botToken: string;
  private allowedChannelIds: Set<string>;
  private allowedGuildIds: Set<string>;
  private prefix: string;
  private client: any = null;

  constructor(config: Record<string, unknown>) {
    this.botToken = (config.botToken as string) || "";
    this.prefix = (config.commandPrefix as string) || "@tasksmith";

    // Channel scoping: accept array or legacy single string
    const channels = config.allowedChannelIds || config.channelIds || [];
    const legacyChannel = config.channelId as string | undefined;
    const channelList = Array.isArray(channels) ? channels.map(String) : [];
    if (legacyChannel && !channelList.includes(legacyChannel)) channelList.push(legacyChannel);
    this.allowedChannelIds = new Set(channelList.filter(Boolean));

    // Guild scoping
    const guilds = config.allowedGuildIds || config.guildIds || [];
    this.allowedGuildIds = new Set(
      (Array.isArray(guilds) ? guilds.map(String) : []).filter(Boolean)
    );
  }

  async start(callback: InboundCallback): Promise<void> {
    try {
      const { Client, GatewayIntentBits } = await import("discord.js");

      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });

      this.client.once("clientReady", () => {
        console.log(`[discord_bot] Connected as ${this.client.user?.tag}`);
        if (this.allowedGuildIds.size > 0) {
          console.log(`[discord_bot] Guild allowlist: ${[...this.allowedGuildIds].join(", ")}`);
        }
        if (this.allowedChannelIds.size > 0) {
          console.log(`[discord_bot] Channel allowlist: ${[...this.allowedChannelIds].join(", ")}`);
        }
        if (this.allowedGuildIds.size === 0 && this.allowedChannelIds.size === 0) {
          console.warn("[discord_bot] WARNING: No guild or channel restrictions — bot accepts commands from any channel in any server");
        }
      });

      this.client.on("messageCreate", async (message: any) => {
        if (message.author.bot) return;

        const guildId = message.guild ? String(message.guild.id) : "";
        const channelId = String(message.channel.id);

        // Guild allowlist: silently drop messages from unlisted guilds
        if (this.allowedGuildIds.size > 0 && !this.allowedGuildIds.has(guildId)) return;

        // Channel allowlist: silently drop messages from unlisted channels
        if (this.allowedChannelIds.size > 0 && !this.allowedChannelIds.has(channelId)) return;

        let content = message.content.trim();

        // Strip prefix
        if (content.toLowerCase().startsWith(this.prefix.toLowerCase())) {
          content = content.slice(this.prefix.length).trim();
        }

        if (!content) return;

        await callback({
          source: "discord_bot",
          sender: String(message.author.tag),
          content,
          timestamp: new Date(),
          metadata: { channelId, messageId: String(message.id), guildId },
        });

        // Acknowledge
        await message.react("⚡").catch(() => {});
      });

      await this.client.login(this.botToken);
    } catch (e: any) {
      if (e.code === "MODULE_NOT_FOUND") {
        console.error("[discord_bot] discord.js not installed. Run: npm install discord.js");
      } else {
        console.error(`[discord_bot] ${e.message}`);
      }
    }
  }

  async stop(): Promise<void> {
    await this.client?.destroy();
  }

  async test(): Promise<boolean> {
    return Boolean(this.botToken);
  }
}

export class WatchedFolderProvider implements InboundCommsProvider {
  readonly name = "watched_folder";
  private watchPath: string;
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(config: Record<string, unknown>) {
    this.watchPath = (config.path as string) || "";
  }

  async start(callback: InboundCallback): Promise<void> {
    if (!this.watchPath) return;

    this.watcher = watch(this.watchPath, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 500 } });

    this.watcher.on("add", async (filePath: string) => {
      if (!filePath.endsWith(".yaml") && !filePath.endsWith(".yml")) return;
      try {
        const content = readFileSync(filePath, "utf-8");
        await callback({ source: "watched_folder", sender: "external", content, timestamp: new Date(), metadata: { filePath } });
        // Remove after processing
        const { unlinkSync } = await import("node:fs");
        unlinkSync(filePath);
      } catch (e) {
        console.error(`[watched_folder] ${e}`);
      }
    });

    console.log(`[watched_folder] Watching ${this.watchPath}`);
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  async test(): Promise<boolean> {
    try {
      readdirSync(this.watchPath);
      return true;
    } catch {
      return false;
    }
  }
}

export class SlackEventsProvider implements InboundCommsProvider {
  readonly name = "slack_events";
  private port: number;
  private signingSecret: string;
  private triggerPrefix: string;
  private channelIds: Set<string>;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(config: Record<string, unknown>) {
    this.port = (config.port as number) || 8422;
    this.signingSecret = (config.signingSecret as string) || "";
    this.triggerPrefix = (config.triggerPrefix as string) || "/tasksmith";
    const channels = (config.channelIds as string[]) || [];
    this.channelIds = new Set(channels);
  }

  async start(callback: InboundCallback): Promise<void> {
    if (!this.signingSecret) {
      console.error("[slack_events] signingSecret is required. Skipping.");
      return;
    }

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405).end("Method Not Allowed");
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks);
      const bodyStr = rawBody.toString("utf-8");

      // Verify Slack request signature
      const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
      const signature = req.headers["x-slack-signature"] as string | undefined;
      if (!this.verifySlackSignature(bodyStr, timestamp, signature)) {
        res.writeHead(401).end("Invalid signature");
        return;
      }

      let payload: Record<string, any>;
      try {
        payload = JSON.parse(bodyStr);
      } catch {
        res.writeHead(400).end("Invalid JSON");
        return;
      }

      // Handle Slack URL verification challenge
      if (payload.type === "url_verification") {
        res.writeHead(200, { "Content-Type": "text/plain" }).end(payload.challenge);
        return;
      }

      // Process event callbacks
      if (payload.type === "event_callback") {
        const event = payload.event;
        if (!event) {
          res.writeHead(200).end("OK");
          return;
        }

        const msg = this.eventToMessage(event, payload.team_id);
        if (msg) {
          // Respond to Slack quickly to avoid retries (3s timeout)
          res.writeHead(200).end("OK");
          try {
            await callback(msg);
          } catch (e) {
            console.error(`[slack_events] Error handling ${event.type}:`, e);
          }
        } else {
          res.writeHead(200).end("OK");
        }
        return;
      }

      res.writeHead(200).end("OK");
    });

    this.server.listen(this.port, () => {
      console.log(`[slack_events] Listening on :${this.port}`);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  async test(): Promise<boolean> {
    return Boolean(this.signingSecret);
  }

  // ── Signature Verification ──────────────────────────────────────

  private verifySlackSignature(body: string, timestamp: string | undefined, signature: string | undefined): boolean {
    if (!timestamp || !signature) return false;

    // Reject requests older than 5 minutes to prevent replay attacks
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 300) return false;

    const baseString = `v0:${timestamp}:${body}`;
    const expected = "v0=" + createHmac("sha256", this.signingSecret).update(baseString).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ── Event → InboundMessage Mapping ──────────────────────────────

  private eventToMessage(event: Record<string, any>, teamId: string): InboundMessage | null {
    // Skip bot messages
    if (event.bot_id || event.subtype === "bot_message") return null;

    const eventType = event.type as string;

    // app_mention — someone @mentioned the bot
    if (eventType === "app_mention") {
      return this.parseSlackMessage(event, teamId);
    }

    // message — direct message or channel message
    if (eventType === "message" && !event.subtype) {
      // Filter by channel if configured
      if (this.channelIds.size > 0 && !this.channelIds.has(event.channel)) {
        return null;
      }
      return this.parseSlackMessage(event, teamId);
    }

    return null;
  }

  private parseSlackMessage(event: Record<string, any>, teamId: string): InboundMessage | null {
    let text = (event.text || "").trim();

    // Strip bot mention (<@U12345>) if present
    text = text.replace(/<@[A-Z0-9]+>/g, "").trim();

    // Require trigger prefix for channel messages (not DMs)
    if (event.channel_type !== "im") {
      if (!text.toLowerCase().startsWith(this.triggerPrefix.toLowerCase())) return null;
      text = text.slice(this.triggerPrefix.length).trim();
    }

    if (!text) return null;

    return {
      source: "slack_events",
      sender: event.user || "unknown",
      content: text,
      timestamp: new Date(parseFloat(event.ts || "0") * 1000),
      metadata: {
        channel: event.channel,
        teamId,
        threadTs: event.thread_ts,
        ts: event.ts,
      },
    };
  }
}

export class GitHubWebhookProvider implements InboundCommsProvider {
  readonly name = "github_webhook";
  private port: number;
  private webhookSecret: string;
  private triggerLabels: Set<string>;
  private triggerComment: string;
  private defaultTemplate: string;
  private defaultModel: string;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(config: Record<string, unknown>) {
    this.port = (config.port as number) || 8421;
    this.webhookSecret = (config.webhookSecret as string) || "";
    this.triggerLabels = new Set((config.triggerLabels as string[]) || ["tasksmith"]);
    this.triggerComment = (config.triggerComment as string) || "/tasksmith";
    this.defaultTemplate = (config.defaultTemplate as string) || "ralph-loop";
    this.defaultModel = (config.defaultModel as string) || "sonnet";
  }

  async start(callback: InboundCallback): Promise<void> {
    if (!this.webhookSecret) {
      console.error("[github_webhook] webhookSecret is required. Skipping.");
      return;
    }

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405).end("Method Not Allowed");
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks);

      // Verify HMAC-SHA256 signature
      const sig = req.headers["x-hub-signature-256"] as string | undefined;
      if (!this.verifySignature(rawBody, sig)) {
        res.writeHead(401).end("Invalid signature");
        return;
      }

      let payload: Record<string, any>;
      try {
        payload = JSON.parse(rawBody.toString("utf-8"));
      } catch {
        res.writeHead(400).end("Invalid JSON");
        return;
      }

      const event = req.headers["x-github-event"] as string;
      const msg = this.eventToMessage(event, payload);

      if (msg) {
        try {
          await callback(msg);
          res.writeHead(200).end("Accepted");
        } catch (e) {
          console.error(`[github_webhook] Error handling ${event}:`, e);
          res.writeHead(500).end("Internal error");
        }
      } else {
        // Event didn't match any trigger — acknowledge but ignore
        res.writeHead(200).end("Ignored");
      }
    });

    this.server.listen(this.port, () => {
      console.log(`[github_webhook] Listening on :${this.port}`);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  async test(): Promise<boolean> {
    return Boolean(this.webhookSecret);
  }

  // ── Signature Verification ──────────────────────────────────────

  private verifySignature(body: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = "sha256=" + createHmac("sha256", this.webhookSecret).update(body).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ── Event → InboundMessage Mapping ──────────────────────────────

  private eventToMessage(event: string, payload: Record<string, any>): InboundMessage | null {
    const action = payload.action as string | undefined;
    const repo = payload.repository?.full_name || "unknown";
    const sender = payload.sender?.login || "github";

    // issues.opened or issues.labeled — structured task from labeled issues
    if (event === "issues" && (action === "opened" || action === "labeled")) {
      const issue = payload.issue;
      if (!issue) return null;

      const labels: string[] = (issue.labels || []).map((l: any) => l.name || l);
      const hasMatch = labels.some((l: string) => this.triggerLabels.has(l));
      if (!hasMatch) return null;

      const taskYaml = this.issueToTaskYaml(issue, repo, labels);
      return {
        source: "github_webhook",
        sender,
        content: taskYaml,
        timestamp: new Date(),
        metadata: {
          event,
          action,
          repo,
          issueNumber: issue.number,
          labels,
        },
      };
    }

    // issue_comment.created — natural language trigger via comment
    if (event === "issue_comment" && action === "created") {
      const comment = payload.comment;
      const issue = payload.issue;
      if (!comment || !issue) return null;

      const body = (comment.body || "").trim();
      if (!body.toLowerCase().startsWith(this.triggerComment.toLowerCase())) return null;

      // Strip trigger prefix, pass the rest as natural language
      const prompt = body.slice(this.triggerComment.length).trim();
      if (!prompt) return null;

      // Include issue context so nlToTask has something to work with
      const content = `GitHub Issue #${issue.number}: ${issue.title}\n\n${prompt}`;
      return {
        source: "github_webhook",
        sender,
        content,
        timestamp: new Date(),
        metadata: {
          event,
          action,
          repo,
          issueNumber: issue.number,
          commentId: comment.id,
        },
      };
    }

    return null;
  }

  // ── Issue → Structured YAML ─────────────────────────────────────

  private issueToTaskYaml(issue: Record<string, any>, repo: string, labels: string[]): string {
    return yaml.dump({
      template: this.defaultTemplate,
      prompt: `GitHub Issue #${issue.number}: ${issue.title}\n\n${issue.body || "(no description)"}`,
      project: repo,
      model: this.defaultModel,
      priority: "normal",
      params: {
        github_issue: issue.number,
        github_repo: repo,
        labels: labels.join(", "),
      },
    }, { lineWidth: 120 });
  }
}

// =============================================================================
// REGISTRIES
// =============================================================================

export const OUTBOUND_REGISTRY: Record<string, new (config: Record<string, unknown>) => OutboundCommsProvider> = {
  discord_webhook: DiscordWebhookProvider,
  ntfy: NtfyProvider,
  slack_webhook: SlackWebhookProvider,
  email: EmailProvider,
  webhook_generic: GenericWebhookProvider,
};

// Inbound registry needs special handling (FileDropProvider takes extra args)
export function createInboundProvider(name: string, config: Record<string, unknown>, inboxPath: string): InboundCommsProvider | null {
  switch (name) {
    case "file_drop": return new FileDropProvider(config, inboxPath);
    case "discord_bot": return new DiscordBotProvider(config);
    case "watched_folder": return new WatchedFolderProvider(config);
    case "github_webhook": return new GitHubWebhookProvider(config);
    case "slack_events": return new SlackEventsProvider(config);
    // rest_api is handled by the coordinator directly (starts Fastify)
    default: return null;
  }
}
