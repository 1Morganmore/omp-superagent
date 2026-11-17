import * as fs from "node:fs/promises";
import * as net from "node:net";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { collectReports, collectScope, targetScope } from "@oh-my-pi/pi-coding-agent/cli/ps-data";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookup as lookupSetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { pickDefaultAvailableModel, resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resolveThinkingLevelForModel } from "@oh-my-pi/pi-tui/thinking";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { HostChannel, serviceCompletionRecorded, type Frame } from "./host-protocol";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { fitAbortAndRestoreQueueResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcAbortAndRestoreQueueResult, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { LanePresetSnapshot } from "./contracts";

/** Runs inside the installed native host. All native objects come from injected pi.pi. */
export default function hostExtension(pi: ExtensionAPI): void {
  const socketPath = process.env.OMP_SUPERAGENT_NATIVE_SOCKET;
  const configPath = process.env.OMP_SUPERAGENT_HOST_CONFIG;
  if (!socketPath || !configPath) return;
  const goalEnabled = lookupSetting("goal.enabled");
  if (!goalEnabled) throw new Error("Installed OMP lacks the public goal.enabled setting");
  let context: ExtensionContext | undefined;
  let server: net.Server | undefined;
  let mutationHeld = false;
  let observationHeld = false;
  let runOrdinal = 0;
  let instanceKey: string | undefined;
  const serviceStarts = new Map<string, { name: string; cwd: string; owner: string }>();
  const interrupts = new Map<string, Promise<PromiseSettledResult<void>[]>>();
  const generationKey = (value: Frame) => JSON.stringify([value.owner, value.id, value.startedAt, value.restartCount]);
  const rootSession = () => {
    const root = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
    if (!(root instanceof pi.pi.AgentSession)) throw new Error("Native root session is unavailable");
    return root;
  };
  const serviceObservation = (data: Frame) => {
    const root = rootSession();
    root.sessionManager.appendCustomEntry("superagent_service_generation", {
      rootSessionId: root.sessionManager.getSessionId(), ...data,
    });
    root.sessionManager.flushSync();
  };
  // Registry slots differ between the standalone executable and npm SDK.
  // Mirror native layers into this SDK before using any imported setting handle.
  const readOnly = (settings: Settings): Settings => {
    const parent = settings.overlayParent();
    return Settings.mirror({
      write() { throw new Error("Native settings observation is read-only"); },
      refresh() { throw new Error("Native settings observation is read-only"); },
      cloneForCwd() { throw new Error("Native settings observation is read-only"); },
    }, settings.mirrorState(), parent ? readOnly(parent) : undefined);
  };
  const exact = () => {
    const ref = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID);
    const session = ref?.session;
    if (!ref || !context || !(session instanceof pi.pi.AgentSession)
      || session.sessionManager.getSessionId() !== context.sessionManager.getSessionId()
      || session.sessionManager.getSessionFile() !== context.sessionManager.getSessionFile())
      throw new Error("Exact native session ownership is unavailable");
    if (typeof session.hasAdmittedSubmission !== "boolean" || typeof session.hasPostPromptWork !== "boolean"
      || typeof session.isBusyForSnapshot !== "boolean" || typeof session.isStreaming !== "boolean"
      || typeof session.isCompacting !== "boolean" || typeof session.isDisposed !== "boolean"
      || !Number.isSafeInteger(session.queuedMessageCount) || session.queuedMessageCount < 0
      || typeof session.instanceKey !== "string" || !session.instanceKey
      || !("wakeSources" in session) || typeof session.getAsyncJobTree !== "function"
      || typeof session.getAsyncJobSnapshot !== "function" || typeof session.beginDispose !== "function"
      || typeof session.abortCompaction !== "function" || typeof session.goalRuntime.pauseGoal !== "function"
      || typeof session.waitForIdle !== "function" || typeof session.yieldQueue?.has !== "function"
      || typeof session.sessionManager.ensureOnDisk !== "function" || typeof session.sessionManager.flushSync !== "function"
      || typeof session.settings.reloadFromDisk !== "function" || typeof session.settings.mirrorState !== "function"
      || typeof session.settings.getModelRoles !== "function")
      throw new Error("Installed OMP lacks required public native lifecycle capabilities");
    if (instanceKey !== undefined && session.instanceKey !== instanceKey)
      throw new Error("Native session instance changed within this managed Host");
    instanceKey ??= session.instanceKey;
    return { ref, session, id: session.sessionManager.getSessionId(), file: session.sessionManager.getSessionFile() };
  };
  const snapshot = () => {
    const { session } = exact();
    return { modelRoles: session.settings.getModelRoles(),
      defaultThinkingLevel: cfgDefaultThinkingLevel.get(readOnly(session.settings)) };
  };
  const observation = (customType: string, data: Frame) => {
    const { session, id, file } = exact();
    try {
      pi.appendEntry(customType, { ...data, sessionId: id, sessionFile: file, instanceKey: session.instanceKey });
      session.sessionManager.flushSync();
      const entry = session.sessionManager.getEntries().at(-1);
      if (entry?.type !== "custom" || entry.customType !== customType)
        throw new Error("Native observation entry identity is unavailable");
      return entry.id;
    } catch (error) { observationHeld = true; throw error; }
  };
  const owned = async (drain = false) => {
    const identity = exact();
    const registry = pi.pi.AgentRegistry.global();
    const refs = registry.list();
    const refEpoch = refs.map(ref => [ref.id, ref.generation, ref.parentId, ref.session?.instanceKey, ref.sessionFile]);
    const journal = identity.session.sessionManager.getEntries();
    const lineage = journal.flatMap(entry => {
      if (entry.type !== "custom" || entry.customType !== "superagent_native_descendant") return [];
      const data = entry.data as { rootSessionId?: string; agentId?: string; parentId?: string; sessionId?: string };
      return data?.rootSessionId === identity.id && typeof data.agentId === "string"
        && typeof data.parentId === "string" && typeof data.sessionId === "string" ? [data] : [];
    });
    const agents = new Set([pi.pi.MAIN_AGENT_ID]);
    for (let changed = true; changed;) {
      changed = false;
      for (const ref of refs) if (ref.parentId && agents.has(ref.parentId) && !agents.has(ref.id)) {
        agents.add(ref.id); changed = true;
      }
      for (const row of lineage) if (agents.has(row.parentId!) && !agents.has(row.agentId!)) {
        agents.add(row.agentId!); changed = true;
      }
    }
    const owners = new Set<string>([identity.id, ...agents]);
    const ownerFiles = new Map<string, string>();
    if (identity.file) ownerFiles.set(identity.id, identity.file);
    for (const ref of refs) if (agents.has(ref.id) && ref.session)
      {
        const id = ref.session.sessionManager.getSessionId();
        owners.add(id);
        const file = ref.session.sessionManager.getSessionFile();
        if (file) ownerFiles.set(id, file);
      }
    for (const row of lineage) if (agents.has(row.agentId!)) {
      owners.add(row.sessionId!);
      const file = (row as Frame).sessionFile;
      if (typeof file === "string") ownerFiles.set(row.sessionId!, file);
    }
    for (const ref of refs) if (agents.has(ref.id) && !ref.session
      && !lineage.some(row => row.agentId === ref.id)) {
      if (!ref.sessionFile) throw new Error("Detached descendant service ownership cannot be established");
      const id = await readSessionHeaderId(ref.sessionFile);
      if (!id) throw new Error("Detached descendant session identity is unavailable");
      owners.add(id);
      ownerFiles.set(id, ref.sessionFile);
    }
    const reports = await collectReports(true, {});
    const currentRefs = registry.list();
    if (exact().ref !== identity.ref || currentRefs.length !== refs.length
      || refs.some((ref, index) => currentRefs[index] !== ref))
      throw new Error("Native ownership tree changed during service observation");
    const services = reports.flatMap(report => report.daemons
      .filter(row => owners.has(row.snapshot.owner ?? ""))
      .map(row => ({ ...row, brokerPid: report.scope.brokerPid })));
    // An offline broker's persisted downgrade is not an authoritative live observation.
    const servicesUnknown = services.some(row => !row.supervised || !row.brokerPid || !row.snapshot.owner);
    const liveServices = services.some(row => !["exited", "failed"].includes(row.snapshot.state));
    const deliveriesPending = (session: InstanceType<typeof pi.pi.AgentSession>) => {
      const delivery = session.getAsyncJobSnapshot({ recentLimit: 0 })?.delivery;
      return !!delivery && (delivery.delivering || delivery.queued > 0 || delivery.pendingJobIds.length > 0);
    };
    const descendantsUnknown = () => refs.some(ref => agents.has(ref.id) && ref.session !== null
      && !(ref.session instanceof pi.pi.AgentSession));
    const descendantsBusy = () => refs.some(ref => agents.has(ref.id) && ref.id !== pi.pi.MAIN_AGENT_ID
      && (registry.isRunning(ref) || ref.session instanceof pi.pi.AgentSession
        && (ref.session.wakeSources !== undefined || ref.session.hasAdmittedSubmission || ref.session.hasPostPromptWork
          || ref.session.isBusyForSnapshot || ref.session.yieldQueue.has() || deliveriesPending(ref.session))));
    const trackingKnown = journal.some(entry => entry.type === "custom" && entry.customType === "superagent_service_tracking"
      && (entry.data as Frame)?.rootSessionId === identity.id && (entry.data as Frame)?.known === true);
    const generations = journal.flatMap(entry => entry.type === "custom" && entry.customType === "superagent_service_generation"
      && (entry.data as Frame)?.rootSessionId === identity.id ? [entry.data as Frame] : []);
    const serviceEntries = new Map<string, readonly unknown[]>();
    for (const owner of new Set(services.map(row => row.snapshot.owner!).concat(
      generations.map(row => (row.daemon as Frame | undefined)?.owner).filter((owner): owner is string => typeof owner === "string")))) {
      const file = ownerFiles.get(owner);
      if (!file) continue;
      const live = refs.find(ref => ref.session?.sessionManager.getSessionId() === owner)?.session;
      if (!drain && live instanceof pi.pi.AgentSession) {
        serviceEntries.set(owner, live.sessionManager.getEntries());
        continue;
      }
      if (drain && live instanceof pi.pi.AgentSession) {
        await live.waitForIdle();
        await live.sessionManager.ensureOnDisk();
        live.sessionManager.flushSync();
      }
      serviceEntries.set(owner, parseSessionEntries(await fs.readFile(file, "utf8")));
    }
    const recorded = (daemon: Frame) => serviceCompletionRecorded(daemon, serviceEntries.get(String(daemon.owner)) ?? []);
    const tracked = generations.filter(row => row.daemon && typeof row.daemon === "object").map(row => row.daemon as Frame);
    const knownKeys = new Set(tracked.map(generationKey));
    const serviceDeliveryUnknown = generations.some(row => row.uncertain === true)
      || generations.some(row => row.phase === "attempt" && !generations.some(result =>
        result.phase === "result" && result.toolCallId === row.toolCallId))
      || generations.some(row => Array.isArray(row.previous) && row.previous.some(value => {
        const previous = value as Frame;
        return owners.has(String(previous.owner)) && !knownKeys.has(generationKey(previous));
      }))
      || tracked.some(daemon => {
        if (services.some(row => generationKey(row.snapshot as unknown as Frame) === generationKey(daemon)
          && !["exited", "failed"].includes(row.snapshot.state))) return false;
        const entries = serviceEntries.get(String(daemon.owner)) ?? [];
        // A recorded terminal completion supplies the final snapshot even when
        // the broker now exposes a replacement generation under the same name.
        return !entries.some(value => {
          const entry = value as Frame;
          const daemons = (entry.details as Frame | undefined)?.daemons;
          return entry.type === "custom_message" && entry.customType === "launch-completion"
            && Array.isArray(daemons) && daemons.some(value => generationKey(value as Frame) === generationKey(daemon)
              && serviceCompletionRecorded(value as Frame, entries));
        });
      })
      || services.some(row => !trackingKnown || !knownKeys.has(generationKey(row.snapshot as unknown as Frame))
        || ["exited", "failed"].includes(row.snapshot.state) && !recorded(row.snapshot as unknown as Frame));
    if (drain) {
      const refreshed = (await collectReports(true, {})).flatMap(report => report.daemons
        .filter(row => owners.has(row.snapshot.owner ?? "")).map(row => row.snapshot));
      if (!isDeepStrictEqual(services.map(row => row.snapshot), refreshed))
        throw new Error("Native services changed while their durable completion evidence was drained");
    }
    if (!isDeepStrictEqual(refEpoch, registry.list().map(ref =>
      [ref.id, ref.generation, ref.parentId, ref.session?.instanceKey, ref.sessionFile])))
      throw new Error("Native descendant identity changed during completion readback");
    const tree = identity.session.getAsyncJobTree({ recentLimit: 0 });
    return { identity, tree, unknown: servicesUnknown || serviceDeliveryUnknown || descendantsUnknown(),
      busy: liveServices || descendantsBusy() || deliveriesPending(identity.session) || !!tree?.running.length };
  };
  const localIdle = () => {
    const { session } = exact();
    return !mutationHeld && !observationHeld && !session.isDisposed && !session.isBusyForSnapshot && !session.isStreaming
      && !session.isCompacting && !session.hasAdmittedSubmission && !session.hasPostPromptWork
      && session.queuedMessageCount === 0 && session.wakeSources === undefined
      && !session.yieldQueue.has()
      && !session.getGoalModeState()?.enabled;
  };
  const handle = async (command: Frame): Promise<unknown> => {
    if (command.type === "get_session_stats") return exact().session.getSessionStats();
    if (command.type === "get_state") {
      const { session } = exact();
      const queued = session.getQueuedMessages();
      // Adapted from oh-my-pi v18.22.0 rpc-mode.ts (MIT; THIRD_PARTY_NOTICES.md).
      // Copyright (c) 2025 Mario Zechner; 2025-2026 Can Bölük; 2026 Stencil Labs, Inc.
      // This is a live observation while an owner command is pending, never an
      // idle receipt. Disposal still requires the stock RPC settlement check.
      return {
        model: session.model, thinkingLevel: session.thinkingLevel,
        isStreaming: session.isStreaming, isCompacting: session.isCompacting,
        steeringMode: session.steeringMode, followUpMode: session.followUpMode,
        interruptMode: session.interruptMode, sessionFile: session.sessionFile,
        sessionId: session.sessionId, sessionName: session.sessionName,
        autoCompactionEnabled: session.autoCompactionEnabled,
        queuedMessageCount: session.queuedMessageCount, hasPendingAsyncWork: session.wakeSources !== undefined,
        isSettled: false,
        queuedMessages: { steering: [...queued.steering], followUp: [...queued.followUp], liveSteered: queued.liveSteered },
        todoPhases: session.getTodoPhases(), fastModeEnabled: session.isFastModeEnabled(),
        tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
        fastModeActive: session.isFastModeActive(), slowModeSupported: session.isSlowModeSupported(),
        slowModeEnabled: session.isSlowModeEnabled(), slowModeScope: session.getSlowModeScope(),
        usageLimit: session.getUsageLimitState(), messageCount: session.messages.length,
        systemPrompt: session.systemPrompt,
        dumpTools: session.agent.state.tools.map(tool => ({
          name: tool.name, description: tool.description, parameters: toolWireSchema(tool), examples: tool.examples,
        })),
        contextUsage: session.getContextUsage(), goal: session.getGoalModeState() ?? null,
      } satisfies RpcSessionState;
    }
    if (command.type === "interrupt_maintenance") {
      const { session } = exact();
      const restored = command.restoreQueue === true ? session.clearQueue({ forInterrupt: true }) : undefined;
      // abort() raises its barrier and withdraws marked internal context before
      // its first await. Do not await its compaction cleanup until the owner has
      // cancelled native UI; the pending compact may itself be awaiting that UI.
      interrupts.set(String(command.id), Promise.allSettled([session.abort({ reason: USER_INTERRUPT_LABEL })]));
      if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
      return restored ?? {};
    }
    if (command.type === "finish_interrupt") {
      const token = String(command.token);
      const pending = interrupts.get(token);
      if (!pending) throw new Error("Native interrupt completion is unavailable");
      try {
        const [result] = await pending;
        if (result!.status === "rejected") throw result!.reason;
      } finally { interrupts.delete(token); }
      return {};
    }
    if (command.type === "activate") {
      const identity = exact();
      // Native's default tool selection omits the goal tool. Add it only for
      // that default, never widen an explicit --tools or --no-tools selection.
      if (command.toolsExplicitlySelected === false && command.noTools === false
        && goalEnabled.get(readOnly(identity.session.settings)) === true)
        await pi.setActiveTools([...new Set([...pi.getActiveTools(), "goal"])]);
      pi.events.emit("superagent:host-ready", { sessionId: identity.id, sessionFile: identity.file, pid: process.pid });
      return {};
    }
    if (command.type === "observe") {
      if (command.customType !== "rpc_prompt_result") throw new Error("Unsupported native observation");
      return { entryId: observation("rpc_prompt_result", {
        frame: command.frame, runOrdinal: command.runOrdinal, hostPid: command.hostPid,
      }) };
    }
    if (command.type === "snapshot") {
      const ownership = await owned();
      return { hostPid: process.pid, sessionId: ownership.identity.id, sessionFile: ownership.identity.file,
        generation: ownership.identity.ref.generation, instanceKey, settingsScope: "session", modelSettings: snapshot(),
        hasOwnedRunningWork: ownership.unknown ? undefined : ownership.busy, mutationHeld, observationHeld,
        admitted: ownership.identity.session.hasAdmittedSubmission,
        postPromptWork: ownership.identity.session.hasPostPromptWork };
    }
    if (command.type === "set_model_preset") {
      if (!localIdle()) throw new Error("Native session is busy or has an unresolved mutation");
      const ownership = await owned(true);
      if (ownership.unknown || ownership.busy || !localIdle()) throw new Error("Native owned work is not authoritatively drained");
      const preset = command.preset as LanePresetSnapshot;
      if (!preset || typeof preset.modelRoles !== "object"
        || Object.values(preset.modelRoles).some(value => typeof value !== "string"))
        throw new Error("A complete frozen model preset is required");
      mutationHeld = true;
      const settings = ownership.identity.session.settings;
      await settings.reloadFromDisk();
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      const previous = settings.getModelRoles();
      const omitted = new Set([...Object.keys(previous), ...Object.keys(config.modelRoles ?? {})]);
      config.modelRoles = { ...Object.fromEntries([...omitted].map(role => [role, null])), ...preset.modelRoles };
      if (preset.defaultThinkingLevel !== undefined) config.defaultThinkingLevel = preset.defaultThinkingLevel;
      const temporary = `${configPath}.${crypto.randomUUID()}`;
      await fs.writeFile(temporary, JSON.stringify(config), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, configPath);
      await settings.reloadFromDisk();
      if (exact().ref !== ownership.identity.ref || !isDeepStrictEqual(snapshot(), preset))
        throw new Error("Native settings readback differs; mutation remains held");
      const candidates = ownership.identity.session.getAvailableModels();
      const selected = preset.modelRoles.default
        ? resolveModelRoleValue(preset.modelRoles.default, candidates, { settings: readOnly(settings) })
        : { model: pickDefaultAvailableModel(candidates.filter(model => context!.modelRegistry.hasConfiguredAuth(model)),
          provider => context!.modelRegistry.hasConcreteAuth(provider)) };
      const model = selected.model;
      if (!model) throw new Error("Native model resolution failed; mutation remains held");
      const expectedLevel = "thinkingLevel" in selected && selected.thinkingLevel !== undefined
        ? selected.thinkingLevel : preset.defaultThinkingLevel;
      const effectiveLevel = expectedLevel === "auto" ? "auto"
        : expectedLevel === undefined ? undefined : resolveThinkingLevelForModel(model, expectedLevel);
      if (!command.preserveActiveModel) {
        await ownership.identity.session.setModelTemporary(model, expectedLevel);
      }
      if (exact().ref !== ownership.identity.ref || !isDeepStrictEqual(snapshot(), preset)
        || !command.preserveActiveModel && (ownership.identity.session.model?.provider !== model.provider
          || ownership.identity.session.model?.id !== model.id
          || expectedLevel !== undefined && ownership.identity.session.configuredThinkingLevel() !== effectiveLevel))
        throw new Error("Native model/effort readback differs; mutation remains held");
      mutationHeld = false;
      return { name: command.name, settingsScope: "session", preset: snapshot(), model: ownership.identity.session.model };
    }
    if (command.type === "shutdown_host") {
      if (!localIdle()) throw new Error("session_busy");
      const ownership = await owned(true);
      await ownership.identity.session.waitForIdle();
      await ownership.identity.session.sessionManager.ensureOnDisk();
      const finalOwnership = await owned(true);
      if (exact().ref !== ownership.identity.ref || !localIdle() || ownership.unknown || finalOwnership.unknown
        || ownership.busy || finalOwnership.busy) throw new Error("session_busy");
      // The owner has fenced its inputs and revalidated stock state/UI. Nothing
      // awaits between this final native guard, disposal fence and shutdown.
      ownership.identity.session.sessionManager.flushSync();
      ownership.identity.session.beginDispose();
      context!.shutdown();
      return { shutdown: true, sessionId: ownership.identity.id, sessionFile: ownership.identity.file };
    }
    throw new Error("Unsupported private native control");
  };
  pi.on("agent_start", () => {
    if (context?.agent.kind === "main") observation("rpc_agent_start", { runOrdinal: ++runOrdinal, hostPid: process.pid });
  });
  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Frame;
    if (event.toolName !== "bash" || typeof input.name !== "string") return;
    const start = { name: input.name, cwd: ctx.cwd, owner: ctx.sessionManager.getSessionId() };
    serviceStarts.set(event.toolCallId, start);
    const report = await collectScope(await targetScope({ dir: ctx.cwd }));
    serviceObservation({ phase: "attempt", toolCallId: event.toolCallId, ...start,
      previous: report.daemons.filter(row => row.snapshot.name === start.name).map(row => row.snapshot) });
  });
  pi.on("tool_result", async (event, ctx) => {
    const start = serviceStarts.get(event.toolCallId);
    if (!start) return;
    serviceStarts.delete(event.toolCallId);
    const details = event.details as { service?: { name?: string; pid?: number } } | undefined;
    const report = await collectScope(await targetScope({ dir: start.cwd }));
    const row = report.daemons.find(row => row.snapshot.name === start.name && row.snapshot.owner === start.owner
      && row.snapshot.pid === details?.service?.pid);
    serviceObservation({ phase: "result", toolCallId: event.toolCallId, owner: ctx.sessionManager.getSessionId(),
      name: start.name, uncertain: event.isError || !row?.supervised || !report.scope.brokerPid || !details?.service,
      ...(row ? { daemon: row.snapshot } : {}) });
  });
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") {
      const root = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
      if (!(root instanceof pi.pi.AgentSession) || !ctx.agent.parentId)
        throw new Error("Native descendant root ownership is unavailable");
      root.sessionManager.appendCustomEntry("superagent_native_descendant", {
        rootSessionId: root.sessionManager.getSessionId(), agentId: ctx.agent.id, parentId: ctx.agent.parentId,
        sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
      });
      root.sessionManager.flushSync();
      return;
    }
    if (server) return;
    context = ctx;
    const identity = exact();
    await ctx.sessionManager.ensureOnDisk();
    if (exact().ref !== identity.ref) throw new Error("Native session changed during materialization");
    identity.session.sessionManager.flushSync();
    const journal = identity.session.sessionManager.getEntries();
    if (!journal.some(entry => entry.type === "custom" && entry.customType === "superagent_service_tracking")) {
      identity.session.sessionManager.appendCustomEntry("superagent_service_tracking", {
        rootSessionId: identity.id, known: !journal.some(entry =>
          entry.type === "custom_message" && entry.customType === "launch-completion"
          || entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)
            && entry.message.content.some(part => part.type === "toolCall" && part.name === "bash"
              && typeof (part.arguments as Frame).name === "string")),
      });
      identity.session.sessionManager.flushSync();
    }
    server = net.createServer(socket => {
      const channel = new HostChannel(socket, socket, true);
      channel.encoder.setProtocolVersion(2);
      channel.on("frame", (command: Frame) => {
        if (typeof command.id !== "string") return;
        void handle(command).then(data => {
          channel.send(command.type === "interrupt_maintenance" && command.restoreQueue === true
            ? fitAbortAndRestoreQueueResponse(command.id as string, data as RpcAbortAndRestoreQueueResult, channel.encoder.maxResponseBytes)
            : { type: "response", command: command.type, id: command.id, success: true, data });
        }, error => {
          channel.send({ type: "response", command: command.type, id: command.id, success: false,
            error: error instanceof Error ? error.message : String(error) });
        });
      });
      channel.send({ type: "ready" });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => { void fs.chmod(socketPath, 0o600).then(resolve, reject); });
    });
  });
  pi.on("session_shutdown", async () => {
    if (!context || context.agent.kind !== "main") return;
    server?.close();
    await fs.unlink(socketPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  });
}
