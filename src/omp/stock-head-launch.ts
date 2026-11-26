import { createHash } from "node:crypto";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";

export function stockReplayRefusal(parsed: Args | null, sessionFile: string): string | undefined {
  if (parsed?.mode !== "rpc-ui" || parsed.resume !== sessionFile)
    return "HEAD wake requires an exact stock rpc-ui session launch";
  if (parsed.fork !== undefined || parsed.continue || parsed.restore || parsed.noSession || parsed.fromClaude || parsed.fromCodex)
    return "HEAD wake cannot combine competing stock session selectors";
  if (parsed.maxTime !== undefined)
    return "Stock --max-time starts a new deadline on launch; HEAD wake cannot restore its remaining time";
  if (parsed.prewalk || parsed.prewalkInto !== undefined)
    return "Stock --prewalk or --prewalk-into rearms one-shot planning on launch; HEAD wake cannot restore its prior state";
  if (parsed.planYolo || parsed.planYoloInto !== undefined)
    return "Stock --plan-yolo rearms autonomous planning on launch; HEAD wake cannot restore its prior state";
  if (parsed.unrecognizedFlags.includes("--preset"))
    return "Stock OMP has no --preset launch selector; an extension-owned --preset cannot be restored by HEAD wake";
  if (parsed.goal !== undefined || parsed.messages.length || parsed.fileArgs.length
      || parsed.invalidFlagValues.length || parsed.unrecognizedFlags.length || parsed.unknownFlags.size)
    return "HEAD wake cannot prove replay of stock startup input or extension-owned flags";
}

export function launchArgvHash(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}

/** The helper has parsed these exact arguments before spawn. A wrapper may
 * change them, and only the live extension runner knows which flags it owns. */
export function matchesPreparedLaunch(argv: readonly string[], prepared: unknown, flags?: ReadonlyMap<string, unknown>): boolean {
  return typeof prepared === "string" && flags !== undefined && launchArgvHash(argv) === prepared
    && !argv.some(arg => arg.startsWith("--") && flags.has(arg.slice(2).split("=", 1)[0]));
}
