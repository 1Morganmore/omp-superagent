import { lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { RotationSelection } from "../runtime/head-rotation";
import { stockReplayRefusal } from "./stock-head-launch";

type HeadResumeInput = {
  readonly argv: readonly string[];
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly selection: RotationSelection;
  readonly checkJournal: boolean;
  readonly rotationOnly?: boolean;
};

async function checkHeadResumeJournal(input: HeadResumeInput, needsServiceTier: boolean): Promise<string | undefined> {
  const before = await lstat(input.sessionFile);
  if (!before.isFile()) return "HEAD sleep requires a regular native journal, not a symlink";
  const { loadSessionFile } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
  const { entries, invalidHeader, malformedRecords, sourceSize } =
    await loadSessionFile(input.sessionFile, undefined, { throwIfMissing: true });
  const after = await lstat(input.sessionFile);
  const [header] = entries;
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || sourceSize !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      invalidHeader || malformedRecords !== 0 || header?.type !== "session" || header.id !== input.sessionId)
    return "HEAD journal changed or could not be read as the exact native session";
  if (entries.some((entry, i) => i !== 0 && entry.type === "session"))
    return "HEAD journal contains a competing native session header";
  const { lastModelChangeRole, SessionEntryIndex } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
  const index = new SessionEntryIndex();
  const records = entries.filter(entry => entry.type !== "session");
  index.rebuild(records);
  const branch = index.branchView();
  const { buildSessionContext, getRestorableSessionModels } = await import("@oh-my-pi/pi-coding-agent/session/session-context");
  const { models, serviceTier } = buildSessionContext(records, index.leafId(), index.entriesById());
  const saved = getRestorableSessionModels(models, lastModelChangeRole(branch))[0];
  const hasServiceTier = branch.some(entry => entry.type === "service_tier_change");
  if (needsServiceTier && !hasServiceTier)
    return "HEAD cannot remove stock --service-tier without a saved selection on the active journal branch";
  const { selection } = input;
  if (!isDeepStrictEqual(hasServiceTier ? serviceTier ?? {} : selection.serviceTierDefaults, selection.serviceTier))
    return "Stock HEAD resume cannot restore the active service tier from the journal or its native defaults";
  const exact = selection.modelIdentity;
  if (saved === exact) return;
  // Before the first turn stock can leave its model entry in memory only.
  // The restored settings overlay contains the attested effective default,
  // but this fallback cannot override a model stock finds in the journal.
  if (!saved && selection.modelSettings.modelRoles.default === exact) return;
  const { parseModelString } = await import("@oh-my-pi/pi-coding-agent/config/model-selector");
  const parsed = saved && parseModelString(saved, { allowMaxSuffix: true, allowAutoAlias: true });
  if (parsed && `${parsed.provider}/${parsed.id}` === exact) return;
  return "Stock HEAD resume cannot restore the active model from the journal or its exact bootstrap default";
}

/** Prove that stock can restore this exact live selection without replaying one-shot options. */
export async function headResumeCommand(input: HeadResumeInput) {
  const { argv, sessionFile, selection } = input;
  const { extractProfileFlags } = await import("@oh-my-pi/pi-coding-agent/cli/profile-bootstrap");
  const { setProfile, resolveProfileEnv } = await import("@oh-my-pi/pi-utils/dirs");
  const suffix = ["--mode", "rpc-ui", "--session", sessionFile];
  const original = extractProfileFlags([...argv, ...suffix]);
  setProfile(original.profile ?? resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE));
  const { resolveCliArgv } = await import("@oh-my-pi/pi-coding-agent/cli-commands");
  const { parseArgs } = await import("@oh-my-pi/pi-coding-agent/cli/args");
  const parseStockLaunch = (args: string[]) => {
    const resolved = resolveCliArgv(args);
    return "error" in resolved || resolved.argv[0] !== "launch" ? null : parseArgs(resolved.argv.slice(1));
  };
  const parsed = parseStockLaunch(original.argv);
  const refusal = stockReplayRefusal(parsed, sessionFile);
  if (refusal || !parsed) return { refused: refusal ?? "HEAD wake launch was not parsed" };
  const { flagConsumesValue } = await import("@oh-my-pi/pi-coding-agent/cli/flag-tables");
  const command: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const flag = token.split("=", 1)[0];
    const consumesValue = flagConsumesValue(token, argv[i + 1]);
    // The managed --session suffix wins in parseArgs, hiding an earlier
    // selector. Inspect only stock option tokens, not other flags' values.
    if (flag === "--resume" || flag === "-r" || flag === "--session")
      return { refused: "HEAD wake cannot combine competing stock session selectors" };
    if (flag !== "--model" && flag !== "--provider" && flag !== "--thinking" && flag !== "--service-tier") {
      command.push(token);
      if (consumesValue) command.push(argv[i + 1]);
    }
    if (consumesValue) i++;
  }
  if (selection.stockLaunchReplay !== true)
    return { refused: "The original HEAD did not attest that its actual stock launch is replayable" };
  if (input.rotationOnly) return { command: argv };
  if (!selection.modelIdentity || !selection.serviceTier || !selection.serviceTierDefaults || !selection.effectiveServiceTier)
    return { refused: "The original HEAD did not attest its exact routed model and service tier" };
  if (parsed.model && parsed.apiKey)
    return { refused: "Stock --api-key is bound to an explicit --model; HEAD wake cannot rebind it to the saved session model" };
  for (const [role, value] of [["smol", parsed.smol], ["slow", parsed.slow], ["plan", parsed.plan]] as const) {
    if (value && selection.modelSettings.modelRoles[role] !== value)
      return { refused: `HEAD wake cannot replay the conflicting stock --${role} role override` };
  }
  const effort = selection.configuredThinkingLevel ?? undefined;
  if (effort === undefined && selection.reasoning)
    return { refused: "Stock --thinking has no inherit selector for this HEAD's absent reasoning effort" };
  // Let stock restore the branch model and tier. An old --model can overwrite
  // the default role; --service-tier would overwrite even an explicit /fast off.
  // Keep the live configured effort, including auto before it has journaled
  // the first classification.
  if (effort !== undefined) command.push(`--thinking=${effort}`);
  const normalized = extractProfileFlags([...command, ...suffix]);
  const restored = parseStockLaunch(normalized.argv);
  const omitSelection = ({
    model: _model, provider: _provider, thinking: _thinking, serviceTier: _serviceTier, ...other
  }: typeof parsed) => other;
  if (!restored || restored.model !== undefined || restored.provider !== undefined
      || restored.thinking !== effort || restored.serviceTier !== undefined
      || normalized.profile !== original.profile || normalized.aliasName !== original.aliasName
      || !isDeepStrictEqual(omitSelection(restored), omitSelection(parsed)))
    return { refused: "Stock HEAD model, effort and service tier flags cannot be replaced without changing other launch options" };
  if (input.checkJournal) {
    const refused = await checkHeadResumeJournal(input, parsed.serviceTier !== undefined);
    if (refused) return { refused };
  }
  return { command };
}
