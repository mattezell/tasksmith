/**
 * Communication Providers
 *
 * Outbound: send notifications to the user.
 * Inbound: receive commands from the user.
 */

import { watch } from "chokidar";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

  constructor(config: Record<string, unknown>) {
    this.config = config;
  }

  async send(n: Notification): Promise<boolean> {
    // Nodemailer-free SMTP: use child_process to call system sendmail
    // or defer to a future nodemailer optional dep
    // For now: write to comms/outbox as a file (picked up by any MTA)
    console.warn("[email] Email provider requires nodemailer. Install: npm install nodemailer");
    return false;
  }

  async test(): Promise<boolean> {
    return false;
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

  constructor(_config: Record<string, unknown>, inboxPath: string) {
    this.inboxPath = inboxPath;
  }

  async start(callback: InboundCallback): Promise<void> {
    this.watcher = watch(this.inboxPath, { ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 500 } });

    this.watcher.on("add", async (filePath: string) => {
      if (!filePath.endsWith(".yaml") && !filePath.endsWith(".yml")) return;
      try {
        const content = readFileSync(filePath, "utf-8");
        await callback({
          source: "file_drop",
          sender: "local",
          content,
          timestamp: new Date(),
          metadata: { filePath },
        });
      } catch (e) {
        console.error(`[file_drop] Error processing ${filePath}: ${e}`);
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
  private channelId: string;
  private prefix: string;
  private client: any = null;

  constructor(config: Record<string, unknown>) {
    this.botToken = (config.botToken as string) || "";
    this.channelId = (config.channelId as string) || "";
    this.prefix = (config.commandPrefix as string) || "@forge";
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
      });

      this.client.on("messageCreate", async (message: any) => {
        if (message.author.bot) return;

        let content = message.content.trim();

        // Filter by channel if configured
        if (this.channelId && String(message.channel.id) !== this.channelId) {
          if (!content.toLowerCase().startsWith(this.prefix.toLowerCase())) return;
        }

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
          metadata: {
            channelId: String(message.channel.id),
            messageId: String(message.id),
            guildId: message.guild ? String(message.guild.id) : "",
          },
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
    // rest_api is handled by the coordinator directly (starts Fastify)
    default: return null;
  }
}
