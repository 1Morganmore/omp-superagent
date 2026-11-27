// Short-lived SDK operations. The Rust owner, not this process, owns native stdin and the reconnectable socket.
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { chmod, lstat, rename, writeFile } from "node:fs/promises";
import type { RpcAbortAndRestoreQueueResult } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { HostOptions } from "./omp/host";
import type { RotationSelection } from "./runtime/head-rotation";
import type { ManagedUlwLaunchComposition, ManagedUlwLaunchInput } from "./omp/managed-super";
import type { NativeProfile, NativeProfileBinding } from "./omp/native-sessions";
import { launchArgvHash, stockReplayRefusal } from "./omp/stock-head-launch";

type Manifest = {
  readonly options: Omit<HostOptions, "env">;
  readonly args: string[];
  readonly configPath: string;
  readonly processBackend: "broker" | "daemon";
  readonly headRotationSelection?: RotationSelection;
  readonly headHibernationSessionId?: string;
  readonly expectedNativeProfile?: NativeProfile;
  readonly workerMemoryProfile?: NativeProfile;
};

async function run(operation: string | undefined, manifest: Manifest, input: unknown, nativeProfile?: NativeProfile) {
  const { options } = manifest;
  const { extractProfileFlags } = await import("@oh-my-pi/pi-coding-agent/cli/profile-bootstrap");
  const launchArgs = [...options.command.slice(1), ...manifest.args];
  const bootstrap = extractProfileFlags(launchArgs);
  // Native discovery already selected the profile and applied dotenv.
  // Rebootstrapping now would re-select from the mutated environment or
  // clear its effective agent directory before publishing the session.
  if (!nativeProfile) {
    const { setProfile, resolveProfileEnv } = await import("@oh-my-pi/pi-utils/dirs");
    setProfile(bootstrap.profile ?? resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE));
  }
  switch (operation) {
    case "prepare": {
      const { resolveCliArgv } = await import("@oh-my-pi/pi-coding-agent/cli-commands");
      const { parseArgs } = await import("@oh-my-pi/pi-coding-agent/cli/args");
      const argv = resolveCliArgv(bootstrap.argv);
      if ("error" in argv) throw new Error(argv.error);
      const parsed = parseArgs(argv.argv.slice(1));
      const emptyToolSelection = parsed.tools?.length === 0;
      const parkedSession = manifest.headHibernationSessionId;
      const { matchesNativeProfile, publishNativeSession, sdkNativeProfilePaths } = await import("./omp/native-sessions");
      const requireNativeProfile = () => {
        const expected = manifest.expectedNativeProfile;
        if ((nativeProfile && !matchesNativeProfile(sdkNativeProfilePaths(), nativeProfile))
          || (expected !== undefined && !isDeepStrictEqual(nativeProfile, expected))
          || (parkedSession !== undefined && expected === undefined))
          throw new Error("Native profile changed before journal preparation or publication");
      };
      requireNativeProfile();
      if (options.prReviewOnly) {
        if (parsed.noTools === true || !emptyToolSelection || !parsed.noExtensions ||
            !parsed.noSkills || !parsed.noRules || !parsed.noContextFiles || !parsed.noLsp ||
            !parsed.noTitle || !parsed.noPrewalk || !parsed.offline ||
            parsed.trustedExtensions?.length !== 1 || parsed.config?.length !== 1 || parsed.config[0] !== manifest.configPath)
          throw new Error("Stock CLI arguments do not enforce the static PR review launch policy");
        const { getAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
        const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
        const { cfgDisabledProviders } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
        const { getAllCapabilitiesInfo } = await import("@oh-my-pi/pi-coding-agent/discovery");
        const { getAllPluginToolPaths } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/loader");
        const { PR_REVIEW_GITHUB_ENV } = await import("./omp/host-protocol");
        if (PR_REVIEW_GITHUB_ENV.some(name => process.env[name]))
          throw new Error("Static PR review cannot load GitHub credentials from the native profile");
        const native = await Settings.loadReadOnly({ cwd: options.cwd, agentDir: getAgentDir() });
        // Stock custom tool loading also has an independent legacy plugin scan,
        // outside the capability-provider switch. Refuse such a profile without
        // importing any of those modules in the SDK preparation process.
        if ((await getAllPluginToolPaths(options.cwd)).length)
          throw new Error("Static PR review cannot isolate this profile's legacy plugin tools");
        const disabled = new Set(cfgDisabledProviders.get(native));
        for (const capability of getAllCapabilitiesInfo()) {
          if (["mcps", "tools", "prompts", "slash-commands", "system-prompt"].includes(capability.id))
            for (const provider of capability.providers) disabled.add(provider.id);
        }
        const overlay = JSON.parse(await Bun.file(manifest.configPath).text());
        const staging = `${manifest.configPath}.${crypto.randomUUID()}`;
        await writeFile(staging, JSON.stringify({ ...overlay, disabledProviders: [...disabled] }), { mode: 0o600, flag: "wx" });
        await rename(staging, manifest.configPath);
      }
      const { stat } = await import("node:fs/promises");
      const expectedWorkerSession = process.env.OMP_SUPERAGENT_WORKER_EXPECTED_SESSION;
      const inspect = expectedWorkerSession !== undefined || parkedSession !== undefined || options.prReviewOnly ? lstat : stat;
      const missing = await inspect(options.sessionFile).then(async info => {
        if (parkedSession !== undefined) {
          const { readNativeSessionId } = await import("./omp/native-journal");
          if (!info.isFile() || !parkedSession || await readNativeSessionId(options.sessionFile, info) !== parkedSession)
            throw new Error("HEAD journal no longer matches the hibernated session");
        }
        if (expectedWorkerSession !== undefined) {
          const { readSessionHeaderId } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
          if (!info.isFile() || !expectedWorkerSession || await readSessionHeaderId(options.sessionFile) !== expectedWorkerSession)
            throw new Error("Worker journal no longer matches the reserved session");
        }
        if (options.prReviewOnly) {
          if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
            throw new Error("Static PR review journal is not a private owned regular file");
          const { visitEntriesFromFileStream } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
          let verified = false;
          await visitEntriesFromFileStream(options.sessionFile, entry => {
            if (entry.type === "custom" && entry.customType === "superagent_pr_review_policy" &&
                isDeepStrictEqual(entry.data, { version: 1, cwd: options.cwd })) verified = true;
          }, { throwIfMissing: true, onMalformedRecord: () => { throw new Error("Static PR review journal is malformed"); } });
          if (!verified) throw new Error("Refusing to restore a journal not created for static PR review");
        }
        return false;
      }, error => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        if (parkedSession !== undefined) throw new Error("Cannot recreate a missing hibernated HEAD session");
        if (expectedWorkerSession) throw new Error("Worker cannot recreate a missing reserved session");
        return true;
      });
      if (missing) {
        requireNativeProfile();
        const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
        const session = SessionManager.create(options.cwd, dirname(options.sessionFile));
        try {
          await session.setSessionFile(options.sessionFile);
          if (options.prReviewOnly)
            session.appendCustomEntry("superagent_pr_review_policy", { version: 1, cwd: options.cwd });
          const selection = manifest.headRotationSelection;
          if (selection) {
            session.appendModelChange(selection.modelIdentity ?? `${selection.provider}/${selection.modelId}`);
            session.appendThinkingLevelChange(selection.thinkingLevel ?? undefined, selection.configuredThinkingLevel ?? undefined);
          }
          await session.ensureOnDisk();
          session.flushSync();
        } finally { await session.close(); }
        if (options.prReviewOnly) await chmod(options.sessionFile, 0o600);
      }
      let nativeProfileBinding: NativeProfileBinding | undefined;
      let workerMemoryProfileBinding: NativeProfileBinding | undefined;
      if (!options.prReviewOnly) {
        requireNativeProfile();
        const discoveryEntry = await publishNativeSession(options.sessionFile, options.cwd, parkedSession, nativeProfile);
        if (nativeProfile) {
          if (!discoveryEntry) throw new Error("Prepared native session could not be found in discovery");
          nativeProfileBinding = { profile: nativeProfile, discoveryEntry };
        }
        if (manifest.workerMemoryProfile && discoveryEntry
          && matchesNativeProfile(sdkNativeProfilePaths(), manifest.workerMemoryProfile))
          workerMemoryProfileBinding = { profile: manifest.workerMemoryProfile, discoveryEntry };
      }
      const { hostInventoryManifest } = await import("./omp/host-inventory-manifest");
      return { toolsExplicitlySelected: parsed.tools !== undefined, noTools: parsed.noTools === true,
        nativeProfileBinding, workerMemoryProfileBinding,
        replayableArgvHash: argv.argv[0] === "launch" && !stockReplayRefusal(parsed, options.sessionFile)
          ? launchArgvHash(launchArgs) : undefined,
        ...(options.prReviewOnly ? { emptyToolSelection } : {}),
        inventory: await hostInventoryManifest(manifest.processBackend, options.cwd) };
    }
    case "inventory": {
      const { projectDir, serviceName } = input as { projectDir?: string; serviceName?: string };
      const list = manifest.processBackend === "broker"
        ? (await import("./omp/host-broker-services")).brokerServiceInventory(options.cwd)
        : (await import("./omp/host-services")).listServiceUnits;
      return { units: await list(projectDir ?? undefined, serviceName ?? undefined) };
    }
    case "fit": {
      const { id, restored, remaining, maxResponseBytes } = input as { id: string; restored: RpcAbortAndRestoreQueueResult;
        remaining: RpcAbortAndRestoreQueueResult; maxResponseBytes: number };
      const { fitAbortAndRestoreQueueResponse } = await import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode");
      const flags = { ...(restored.imagesDropped || remaining.imagesDropped ? { imagesDropped: true } : {}),
        ...(restored.truncated || remaining.truncated ? { truncated: true } : {}) };
      const result = fitAbortAndRestoreQueueResponse(id, { ...restored, ...remaining,
        steering: [...restored.steering, ...remaining.steering], followUp: [...restored.followUp, ...remaining.followUp] },
        maxResponseBytes - (Object.keys(flags).length ? Buffer.byteLength(JSON.stringify(flags)) : 0));
      if (!result.success || result.command !== "abort_and_restore_queue") throw new Error("Cannot fit restored queue");
      return { ...result, data: { ...result.data, ...flags } };
    }
    default: throw new Error("Unknown Host SDK operation");
  }
}

/**
 * Launch discovery, then session preparation, in this one process. Reads the
 * discovery input line, reports the composition, and prepares only after the
 * launcher answers with its manifest; EOF instead means discovery only.
 */
async function launch() {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Missing launch discovery input");
    buffered += decoder.decode(chunk.value, { stream: true });
  }
  const newline = buffered.indexOf("\n");
  const input: ManagedUlwLaunchInput | null = JSON.parse(buffered.slice(0, newline));
  let rest = buffered.slice(newline + 1);
  let composition: ManagedUlwLaunchComposition;
  if (input === null) {
    composition = { extensionPaths: [], noExtensions: true, memoryWriteDir: null };
  } else {
    const { managedUlwLaunchComposition } = await import("./omp/managed-super");
    try { composition = await managedUlwLaunchComposition(input); }
    catch (error) {
      // Discovery refusals name the launch argument or package the operator must change.
      process.stdout.write(`\nMANAGED_ULW_LAUNCH_ERROR ${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(`\nMANAGED_ULW_LAUNCH ${JSON.stringify(composition)}\n`);
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += decoder.decode(chunk.value, { stream: true });
  rest += decoder.decode();
  if (!rest) return;
  const manifest: Manifest = JSON.parse(rest);
  if (input?.expectedNativeProfile && !isDeepStrictEqual(composition.nativeProfile, input.expectedNativeProfile))
    throw new Error("Native HEAD profile differs from the sleeping checkpoint");
  process.stdout.write(JSON.stringify(await run("prepare", manifest, manifest, composition.nativeProfile)));
}

const [, , operation, path] = process.argv;
try {
  if (operation === "launch") await launch();
  else if (operation === "head-resume-command") {
    const { headResumeCommand } = await import("./omp/head-resume");
    const result = await headResumeCommand(await Bun.stdin.json());
    process.stdout.write(`\nMANAGED_HEAD_RESUME ${JSON.stringify(result)}\n`);
  }
  else if (operation === "prepare") throw new Error("Session preparation follows launch discovery");
  else if (operation === "inventory" || operation === "fit") {
    if (!path) throw new Error("Host manifest is required");
    const input = await Bun.stdin.json();
    const manifest: Manifest = await Bun.file(path).json();
    process.stdout.write(JSON.stringify(await run(operation, manifest, input)));
  } else {
    console.error("Unsupported Host SDK operation");
    process.exitCode = 1;
  }
} catch {
  // SDK errors may contain native frames, authorization data or prompt content.
  console.error("Host SDK operation failed");
  process.exitCode = 1;
}
