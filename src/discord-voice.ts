import { ChannelType, MessageType, type Message, type TextChannel } from "discord.js";
import type { DiscordVoiceConfig } from "./config";
import { routeKey, type Inbound, type OutputRecord } from "./contracts";
import { VoiceDrafts } from "./discord-voice-draft";
import type { openVoiceLink } from "./discord-voice-link";
import type { openLive } from "./openai-live";
import type { openCodexLive } from "./codex-live";

// Keep codecs and the provider out of setup, login, and ordinary text traffic.
const connectDiscord: typeof openVoiceLink = async (...args) =>
  (await import("./discord-voice-link")).openVoiceLink(...args);
const connectProvider: typeof openLive = async (...args) =>
  (await import("./openai-live")).openLive(...args);
const connectSubscription: typeof openCodexLive = async (...args) =>
  (await import("./codex-live")).openCodexLive(...args);

/** One explicitly started session on the existing Gateway client. No background rejoin or paid retries. */
export class DiscordVoice {
  private session?: AbortController;
  private drafts = new VoiceDrafts();
  private readonly awaitingText = new Map<string, string>();
  private notifyReply?: () => void;
  private shareUntil = 0;
  private lastCommand = 0n;
  private readonly startedAt = Date.now();

  constructor(private readonly config: DiscordVoiceConfig, private readonly owner: string,
    private readonly apiKey: string | undefined, private readonly report: (error: unknown) => void, private readonly link = connectDiscord,
    private readonly live = connectProvider, private readonly subscription = connectSubscription) {}

  static isControl(text: string): boolean { return /^\/voice(?:\s|$)/i.test(text.trim()); }

  /** Only called for authorized, original MessageCreate events, never catchup or edits. */
  command(message: Message, input: Inbound): string | null {
    if (message.author.bot || message.author.id !== this.owner || message.webhookId || message.editedTimestamp !== null ||
      (message.type !== MessageType.Default && message.type !== MessageType.Reply) || message.channel.type !== ChannelType.GuildText ||
      message.channelId !== this.config.textChannelId || message.createdTimestamp < this.startedAt ||
      !/^\d{1,20}$/.test(message.id)) return null;
    const sequence = BigInt(message.id);
    if (sequence <= this.lastCommand) return null;
    this.lastCommand = sequence;
    const channel = message.channel;
    const control = message.content.trim();
    if (control === "/voice confirm") {
      const work = this.drafts.consume(message);
      if (work) this.awaitingText.set(input.id, routeKey(input.route));
      if (!work) this.notice(channel, "No matching active voice draft. Reply to the current draft, or write the request directly.");
      return work;
    }
    if (message.type !== MessageType.Default || message.reference || message.attachments.size) return null;
    if (control === "/voice stop") {
      this.close();
      this.notice(channel, "Voice is off.");
    } else if (control === "/voice share" && this.config.auth === "subscription") {
      if (!this.session || !this.notifyReply) this.notice(channel, "Start subscription voice before sharing a work draft.");
      else {
        this.shareUntil = performance.now() + 60_000;
        this.notice(channel, "For one minute, the next voice work draft may be posted here. Speak the task now. Posting is not approval.");
      }
    } else if (control === "/voice start") {
      if (this.session) this.notice(channel, "A voice session is already starting or active.");
      else void this.start(channel).catch(() => this.report(new Error("Discord voice startup failed")));
    } else this.notice(channel, this.config.auth === "subscription"
      ? "Use /voice start or /voice stop. Use /voice share before dictating one work draft for this channel."
      : "Use /voice start or /voice stop. Voice uses paid OpenAI Live audio.");
    return null;
  }

  private async start(text: TextChannel): Promise<void> {
    const session = new AbortController();
    this.session = session;
    const { signal } = session;
    const finish = (reason: string) => {
      if (this.session !== session) return;
      this.close();
      this.notice(text, reason);
    };
    const timer = setTimeout(() => finish("Voice stopped at the configured session time limit."),
      this.config.maxSessionSeconds * 1000);
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    try {
      const config = this.config;
      let connect: (handlers: Parameters<typeof openLive>[1]) => ReturnType<typeof openLive>;
      if (config.auth === "subscription") {
        connect = handlers => this.subscription({ voice: config.voice }, handlers, signal);
      } else {
        const apiKey = this.apiKey;
        if (!apiKey) { finish("A separate voice provider key is required. No Live session was opened."); return; }
        connect = handlers => this.live({ model: config.model, backendModel: config.backendModel, voice: config.voice, apiKey }, handlers, signal);
      }
      const channel = await text.guild.channels.fetch(this.config.channelId);
      if (signal.aborted) return;
      if (channel?.type !== ChannelType.GuildVoice || channel.guildId !== text.guildId ||
        text.guild.voiceStates.cache.get(this.owner)?.channelId !== channel.id) {
        finish("Join the configured voice channel in this server before starting voice."); return;
      }
      let provider: Awaited<ReturnType<typeof openLive>> | undefined;
      const ended = () => finish("Voice session ended. Use /voice start to open a new session.");
      const activeLink = await this.link(channel, this.owner, {
        audio: pcm => { if (!signal.aborted) provider?.input(pcm); },
        ended,
      }, signal);
      if (signal.aborted) { activeLink.close(); return; }
      provider = await connect({
        audio: pcm => { if (!signal.aborted) activeLink.play(pcm); },
        interrupt: () => activeLink.clear(), ended,
        forward: async request => {
          signal.throwIfAborted();
          if (config.auth === "subscription") {
            if (!this.shareUntil || performance.now() >= this.shareUntil) throw new Error("No written permission to share a voice draft");
            this.shareUntil = 0;
          }
          await this.drafts.propose(text, this.owner, request, signal);
          return "Draft posted for written confirmation. Not yet submitted to HEAD or executed.";
        },
      });
      if (signal.aborted) { provider.close(); return; }
      this.notifyReply = () => provider?.notifyHeadReply();
      this.notice(text, config.auth === "subscription"
        ? "Voice ready. Audio goes to OpenAI using your Codex subscription. To post one work draft here, type /voice share before dictating it. Use /voice stop to disconnect."
        : "Voice ready. Your audio goes to OpenAI Live. Use /voice stop to disconnect.");
    } catch {
      // Never send SDK errors, bearer headers, owner audio, or transcripts to Discord/logs.
      finish(this.config.auth === "subscription"
        ? "Could not open Codex subscription voice. Check the voice bridge, subscription login, voice access and Discord channel. No API fallback."
        : "Could not open voice. Check channel membership, permissions, voice dependencies and provider settings. No automatic retry.");
    }
  }

  private notice(channel: TextChannel, content: string): void {
    void channel.send({ content, allowedMentions: { parse: [] } }).catch(() => this.report(new Error("Discord voice notice delivery failed")));
  }

  textDelivered(output: OutputRecord): void {
    if (this.awaitingText.get(output.sourceId) !== routeKey(output.route)) return;
    this.awaitingText.delete(output.sourceId);
    // Discord delivery succeeded; a best-effort spoken notice cannot change that outcome.
    try { this.notifyReply?.(); } catch { this.report(new Error("Voice reply notification failed")); }
  }

  close(): void {
    const session = this.session;
    this.session = undefined;
    this.notifyReply = undefined;
    this.shareUntil = 0;
    this.awaitingText.clear();
    session?.abort();
    this.drafts.clear();
  }
}
