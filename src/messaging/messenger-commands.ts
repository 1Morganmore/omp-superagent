import catalog from "./messenger-command-catalog.json" with { type: "json" };
import type { Inbound } from "../contracts";

/** Owner controls and platform-specific registration metadata shared with the native Gateway. */
export const MESSENGER_COMMAND_CATALOG: readonly {
  readonly name: string;
  readonly description: string;
  readonly text?: string;
  readonly discordOnly?: boolean;
  readonly discord?: {
    readonly description: string;
    readonly text: boolean;
  };
}[] = catalog;

export const MESSENGER_COMMANDS = MESSENGER_COMMAND_CATALOG.filter(command => !command.discordOnly);

/** Never promote a slash token exposed by Telegram's routing-only redaction. */
export function telegramCommandBlocked(input: Inbound): boolean {
  if (input.route.platform !== "telegram" || input.pickerSelection) return false;
  if (input.telegramProtectedCommand !== undefined) return input.telegramProtectedCommand;
  if (input.routingText === undefined) return false;
  // Legacy receipts have no explicit verdict. The old redaction can veto
  // command authority but cannot give it to a different token in the view.
  const written = /^\s*(\/\S+)/u.exec(input.text);
  if (!written) return input.routingText.trimStart().startsWith("/");
  return !input.routingText.startsWith(written[0])
    || !/^(?:\s|$)/u.test(input.routingText.slice(written[0].length));
}

/** Ordinary Slack messages use mrkdwn entities; slash payloads and picker values do not. */
export function messengerCommandText(input: Inbound): string {
  const { text } = input;
  if (input.route.platform !== "slack" || input.messageId === null || !text.includes("&")) return text;
  const name = /^\s*\/([a-z-]+)\s/u.exec(text)?.[1];
  if (!name || !MESSENGER_COMMANDS.some(command => command.name === name)) return text;
  // Decode exactly once. The stored text remains the identity used for replay.
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** Discord may strip this bot's addresses from the edges, but not change the owner's command. */
export function matchesWrittenCommand(input: Inbound): boolean {
  if (input.discordOriginalText === undefined) return true;
  let written = input.discordOriginalText.trim();
  const text = input.text.trim();
  const addresses = [`<@${input.route.accountId}>`, `<@!${input.route.accountId}>`];
  while (written !== text) {
    const leading = addresses.find(tag => written.startsWith(tag));
    if (leading) { written = written.slice(leading.length).trimStart(); continue; }
    const trailing = addresses.find(tag => written.endsWith(tag));
    if (!trailing) return false;
    written = written.slice(0, -trailing.length).trimEnd();
  }
  return true;
}
