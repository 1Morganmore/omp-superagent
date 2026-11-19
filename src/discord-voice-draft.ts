import { ChannelType, MessageFlags, MessageReferenceType, MessageType, type Message, type TextChannel } from "discord.js";
import { DeliveryError } from "./delivery.ts";

const CONFIRM = "/voice confirm";
export const VOICE_DRAFT_HEADER = "Proposed work from the live voice session (not yet submitted).\n";
const PROPOSAL_TTL_MS = 5 * 60 * 1000;
const MESSAGE_LIMIT = 2000;

type PostedDraft = {
  readonly id: string;
  readonly createdTimestamp: number;
  readonly accountId: string;
  readonly ownerId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly work: string;
};

type Draft = {
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly posted?: PostedDraft;
};

export class VoiceDrafts {
  private draft: Draft | null = null;
  private sending = false;

  /** The caller supplies the session's already allowlisted, bound guild text channel. */
  async propose(channel: TextChannel, ownerId: string, text: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.sending || this.current()) {
      throw new DeliveryError("A voice work proposal is already outstanding.", "rejected");
    }
    const accountId = channel.client.user?.id;
    if (!accountId || !channel.guildId || channel.type !== ChannelType.GuildText) {
      throw new DeliveryError("Voice work proposals require a bound Discord guild text channel.", "rejected");
    }
    if (text.length > MESSAGE_LIMIT) {
      throw new DeliveryError("Voice work proposal is too long to review in one Discord message.", "rejected");
    }
    const work = text.trim();
    if (!work) throw new DeliveryError("Voice work proposal is empty.", "rejected");

    // A fenced literal cannot render links, custom emoji or Discord mentions.
    // Escape backticks, controls (including bidi overrides), and the escape
    // character itself so the displayed text cannot impersonate the instructions.
    const literal = work.replace(/[\\`\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu, character => character === "\n"
      ? character : `\\u{${character.codePointAt(0)!.toString(16)}}`);
    const content = VOICE_DRAFT_HEADER +
      `\`\`\`\n${literal}\n\`\`\`\n` +
      `To submit this proposal to HEAD, reply to this message with exactly \`${CONFIRM}\` ` +
      "while the voice session is active and within five minutes.\n" +
      "HEAD replies in Discord text. OpenAI Live does not receive the reply content. " +
      "Risky actions still require separate approval.";
    if (content.length > MESSAGE_LIMIT) {
      throw new DeliveryError("Voice work proposal is too long to review in one Discord message.", "rejected");
    }

    const draft = { signal, startedAt: Date.now() };
    const { guildId, id: channelId } = channel;
    this.draft = draft;
    this.sending = true;
    try {
      const sent = await channel.send({
        content, allowedMentions: { parse: [], repliedUser: false }, flags: MessageFlags.SuppressEmbeds,
      }).catch(() => {
        // Discord may have posted the card despite the failure. Keep the slot
        // until expiry or session end; never bind a guess to an unknown message.
        throw new DeliveryError("Voice work proposal delivery is uncertain; it cannot be confirmed.", "uncertain");
      });
      if (this.current() !== draft) {
        throw new DeliveryError("The voice work proposal is no longer active and cannot be confirmed.", "rejected");
      }
      if (!/^[0-9]{1,20}$/.test(sent.id) || sent.author.id !== accountId || !sent.author.bot ||
        sent.channelId !== channelId || sent.guildId !== guildId || sent.content !== content ||
        !Number.isSafeInteger(sent.createdTimestamp)) {
        throw new DeliveryError("Discord did not verify the voice work proposal; it cannot be confirmed.", "uncertain");
      }
      this.draft = {
        signal, startedAt: Date.now(),
        posted: { id: sent.id, createdTimestamp: sent.createdTimestamp, accountId, ownerId, guildId, channelId, work },
      };
    } finally {
      this.sending = false;
    }
  }

  /** Call only for fresh MessageCreate events, never for updates or fetched history. */
  consume(message: Message): string | null {
    const draft = this.current()?.posted;
    if (!draft || message.content !== CONFIRM || message.type !== MessageType.Reply ||
      message.editedTimestamp !== null || message.webhookId !== null ||
      message.author.id !== draft.ownerId || message.author.bot || message.client.user?.id !== draft.accountId ||
      message.channelId !== draft.channelId || message.guildId !== draft.guildId ||
      message.id === draft.id || message.createdTimestamp < draft.createdTimestamp ||
      message.attachments.size || message.stickers.size || message.messageSnapshots.size) return null;

    const reference = message.reference;
    if (!reference || reference.messageId !== draft.id || reference.channelId !== draft.channelId ||
      (reference.guildId !== undefined && reference.guildId !== draft.guildId) ||
      (reference.type !== undefined && reference.type !== MessageReferenceType.Default)) return null;

    this.clear();
    return "Work proposed in a live Discord voice session and confirmed by the owner in writing.\n" +
      "This is an ordinary work request, not a slash command, native control, or approval. " +
      "Apply the usual safety and approval checks.\n\n" + draft.work;
  }

  clear(): void {
    this.draft = null;
  }

  private current(): Draft | null {
    const draft = this.draft;
    if (!draft) return null;
    const elapsed = Date.now() - draft.startedAt;
    if (draft.signal.aborted || elapsed < 0 || elapsed >= PROPOSAL_TTL_MS) {
      this.clear();
      return null;
    }
    return draft;
  }
}
