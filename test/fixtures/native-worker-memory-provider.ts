import { appendFileSync, existsSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@oh-my-pi/pi-ai";
import type { MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { nativeRequestEnvelope } from "./native-request-envelope";
import { nativeToolExchanges, nativeToolTurn } from "./native-tool-transport";

export const memoryFixture = {
  model: { provider: "socket-host-smoke", id: "local" },
  directory: ".sa-memory-proof",
  entered: "entered",
  release: "release",
  seed: "[worker-memory-seed]",
  start: "[worker-memory-start]",
  extend: "[worker-memory-extend]",
  recall: "[worker-memory-recall]",
  startId: "201",
  extendId: "202",
  recallId: "203",
  // None of these words appears in the stored facts; native recall must use vectors.
  query: "zirconium nebula zephyr",
  unshared: "Rookflint fixture control swatches use copper pigment.",
  retained: "Rookflint packet headers use a four-byte manifest tag.",
  learned: "Rookflint decoder errors identify the failing section by ordinal.",
  later: "Rookflint test samples include an empty trailer envelope.",
  firstReport: "Finished the explicit project retain and learn.",
  laterReport: "Finished the follow-up project learn.",
  recallReply: "Searched the native HEAD project bank.",
  embeddingModel: "BAAI/bge-base-en-v1.5",
  embeddingMarker: "enable-test-embeddings",
  embeddingReady: "embedding-ready.json",
  embeddingCalls: "embedding-calls.jsonl",
} as const;

export const memoryFixtureVectors = {
  [memoryFixture.retained]: [1, 0, 0],
  [memoryFixture.learned]: [0.875, 0.125, 0],
  [memoryFixture.later]: [0.75, 0, 0.25],
} as const;

/** Install only the provider on the live scoped stock memory handle, never a global resolver. */
export function installNativeWorkerMemoryEmbeddings(pi: ExtensionAPI, home: string): void {
  const f = memoryFixture;
  const marker = join(home, f.directory);
  if (!existsSync(join(marker, f.embeddingMarker))) return;
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const root = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID);
    const session = root?.session;
    const agentDir = join(home, ".omp", "agent");
    if (root?.id !== ctx.agent.id || !(session instanceof pi.pi.AgentSession)
      || session.sessionId !== ctx.sessionManager.getSessionId()
      || session.settings.getAgentDir() !== agentDir || session.sessionManager.getCwd() !== ctx.cwd) {
      throw new Error("The isolated vector fixture did not bind its exact stock HEAD session");
    }
    const state = session.getMnemopiSessionState();
    const options = state?.memory.runtimeOptions?.embeddings;
    if (state?.config.dbPath !== join(agentDir, "memory", "mnemopi.db") || state.config.scoping !== "per-project"
      || !options || options.disabled !== false || options.model !== f.embeddingModel || options.apiUrl !== undefined
      || options.provider !== undefined || options.allowLocal?.() !== false || options.allowLocalLoad?.() !== false
      || options.allowRemote?.("https://example.invalid") !== false) {
      throw new Error("Expected the private stock offline vector profile with no external embedding path");
    }
    const inputs = new Map<string, { readonly label: string; readonly vector: readonly number[] }>([
      [f.retained, { label: "retain", vector: memoryFixtureVectors[f.retained] }],
      [f.learned, { label: "learn", vector: memoryFixtureVectors[f.learned] }],
      [f.later, { label: "follow-up", vector: memoryFixtureVectors[f.later] }],
      [f.query, { label: "recall", vector: [1, 0, 0] }],
    ]);
    // Stock checks an empty endpoint only for this injected provider. Preserve
    // the existing offline prohibition on loaded and newly initialized local models.
    options.allowRemote = endpoint => endpoint === "";
    options.provider = {
      async *embed(texts) {
        const batch = texts.map(text => {
          const input = inputs.get(text);
          if (!input) throw new Error("Input is not part of the isolated vector fixture");
          return input;
        });
        appendFileSync(join(marker, f.embeddingCalls), `${JSON.stringify(batch.map(input => input.label))}\n`, { mode: 0o600 });
        yield batch.map(input => [...input.vector]);
      },
    };
    await writeFile(join(marker, f.embeddingReady), JSON.stringify({
      pid: process.pid, sessionId: session.sessionId, model: options.model,
    }), { flag: "wx", mode: 0o600 });
  });
}

/** Script only inference. Persistence and recall go through the advertised native tools. */
export function nativeWorkerMemoryTurn(pi: ExtensionAPI, context: Context): Promise<MockResponse> | undefined {
  const user = context.messages.findLastIndex(message => message.role === "user");
  const message = context.messages[user];
  if (message?.role !== "user") return;
  const { content } = message;
  const text = typeof content === "string" ? content
    : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  const f = memoryFixture;
  const role = process.env.OMP_SUPERAGENT_ROLE;
  const request = nativeRequestEnvelope(text);
  const action = role === "head"
    ? request?.requestId === f.startId && text.includes(f.start) ? "start"
      : request?.requestId === f.recallId && text.includes(f.recall) ? "recall" : undefined
    : role === "lane"
      ? request?.sourceId === f.startId && text.includes(f.start) ? "write"
        : request?.sourceId === f.extendId && text.includes(f.extend) ? "extend"
        : !request && text.includes(f.seed) ? "seed" : undefined
      : undefined;
  if (!action) return;

  return (async () => {
    const home = process.env.HOME;
    const path = home && join(home, f.directory);
    if (!path || !existsSync(path)) throw new Error("Native worker memory fixture requires its isolated profile marker");
    const turn = nativeToolTurn(pi, context, nativeToolExchanges(context.messages.slice(user + 1)));
    if (turn.failed.length) throw new Error(`Native worker memory tool failed: ${JSON.stringify(turn.failed)}`);
    const invoke = (name: string, args: Record<string, unknown>) =>
      turn.invoke(name, args, `ssh-memory:${action}:${name}:${context.messages.length}`);
    if (action === "start") {
      if (!turn.succeeded("lane_start")) return invoke("lane_start", {
        sourceId: f.startId, title: "SSH worker project memory", cwd: process.cwd(),
        kickoff: "I will retain and learn the fixture's project facts on the enrolled worker.",
        brief: "Explicit project memory writes only.", model: f.model,
        modelReason: "The deterministic offline provider is the only fixture model.",
        placement: { target: "remote" },
      });
      return { content: ["The enrolled lane has been assigned to retain and learn the project facts."] };
    }
    if (action === "recall") {
      // Do not supply fact text in the query or synthesize a successful native tool answer.
      if (!turn.succeeded("recall")) return invoke("recall", { query: f.query });
      return { content: [f.recallReply] };
    }
    if (action === "seed") {
      if (!turn.succeeded("retain")) return invoke("retain", { items: [{ content: f.unshared }] });
      return { content: ["Stored the control fact in the ordinary worker profile."] };
    }
    if (action === "extend") {
      if (!turn.succeeded("learn")) return invoke("learn", { memory: f.later });
      return { content: [f.laterReport] };
    }
    if (!turn.succeeded("retain")) return invoke("retain", { items: [{ content: f.retained }] });
    if (!turn.succeeded("learn")) return invoke("learn", { memory: f.learned });

    // Both writes have completed, but the model turn remains real native work.
    const release = join(path, f.release);
    const resumed = Promise.withResolvers<void>();
    const watcher = watch(path, () => { if (existsSync(release)) resumed.resolve(); });
    try {
      await writeFile(join(path, f.entered), String(process.pid), { mode: 0o600, flag: "wx" });
      if (!existsSync(release)) await resumed.promise;
    } finally { watcher.close(); }
    return { content: [f.firstReport] };
  })();
}
