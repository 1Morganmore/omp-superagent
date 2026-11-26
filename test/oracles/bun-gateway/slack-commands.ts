import { MESSENGER_COMMANDS } from "../../../src/messaging/messenger-commands";

type SlackCommand =
  | { readonly kind: "accepted"; readonly text: string }
  | { readonly kind: "unregistered" }
  | { readonly kind: "unexpected-argument" };

/** Only registered names are accepted, and only when permitted to take the supplied text. */
export function parseSlackCommand(name: string, text: string): SlackCommand {
  const command = MESSENGER_COMMANDS.find(command => name === `/superagent-${command.name}`);
  if (!command) return { kind: "unregistered" };
  const argument = text.trim();
  if (argument && command.text === undefined) return { kind: "unexpected-argument" };
  return { kind: "accepted", text: `/${command.name}${argument ? ` ${argument}` : ""}` };
}
