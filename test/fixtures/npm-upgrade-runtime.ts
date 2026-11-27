import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { startReferenceBridge } from "../../scripts/kakao-reference-bridge";
import { privateJson } from "./npm-upgrade-assets";
import { alive, checked, privateGatewaySocket, stopPrivateGateway, until, type GatewaySocket } from "./npm-upgrade-process";

const model = "upgrade-local/local";
const tokenEnv = "OMP_UPGRADE_FIXTURE_KAKAO_TOKEN";
const route = { botUserId: "900", ownerId: "42", chatId: "777" } as const;
const oldPrompt = "Package upgrade: observe the predecessor";
const newPrompt = "Package upgrade: observe the successor";
const oldAnswer = "The predecessor turn completed";
const newAnswer = "The successor turn completed";
// Native config loading (10 s), memory preflight (30 s), launch (45 s) and CLI readback.
const launchTimeout = 100_000;

type Head = {
  readonly hostPid: number; readonly adapterOwnerPid: number; readonly adapterProtocol: string;
  readonly sessionId: string; readonly sessionFile: string;
};
type Status = {
  readonly gateway: { readonly pid: number; readonly ready: boolean; readonly admissionReady: boolean };
  readonly head: { readonly pid: number; readonly connected: boolean; readonly ready: boolean;
    readonly initialization?: { readonly sessionId: string; readonly state: string } };
  readonly ulw: { readonly updating: boolean };
};
type Instance = { readonly head: Head; readonly gatewayPid: number; readonly socket: GatewaySocket };
type Entry = {
  readonly id: string; readonly type: string; readonly customType?: string;
  readonly data?: { readonly hostPid?: number; readonly sessionId?: string;
    readonly frame?: { readonly type: string; readonly id: string; readonly status: string; readonly agentInvoked?: boolean } };
};

async function headState(path: string) {
  const before = await lstat(path);
  assert(before.isSocket() && before.uid === process.getuid?.() && (before.mode & 0o077) === 0);
  const socket = connect(path);
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  const timer = setTimeout(() => socket.destroy(new Error("Installed HEAD get_state timed out")), 7_500);
  const id = crypto.randomUUID();
  try {
    for await (const line of lines) {
      const frame: { type: string; id?: string; protocolVersion?: number; command?: string; success?: boolean;
        data?: Head & { readonly isSettled: boolean } } = JSON.parse(line);
      if (frame.type === "ready") {
        assert.equal(frame.protocolVersion, 1);
        socket.write(`${JSON.stringify({ id, type: "get_state" })}\n`);
      }
      if (frame.type !== "response" || frame.id !== id) continue;
      assert(frame.command === "get_state" && frame.success === true && frame.data, `HEAD did not return its live identity: ${line}`);
      const after = await lstat(path);
      assert.equal(after.dev, before.dev);
      assert.equal(after.ino, before.ino, "HEAD socket changed during state read");
      const { hostPid, adapterOwnerPid, adapterProtocol, sessionId, sessionFile, isSettled } = frame.data;
      return { head: { hostPid, adapterOwnerPid, adapterProtocol, sessionId, sessionFile }, isSettled };
    }
    throw new Error("Installed HEAD closed without returning its live identity");
  } finally {
    clearTimeout(timer);
    lines.close();
    socket.destroy();
  }
}

function startModel() {
  const prompts: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response("Unknown local provider endpoint", { status: 404 });
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("model" in body) || body.model !== "local" ||
        !("messages" in body) || !Array.isArray(body.messages))
      return new Response("Unexpected provider request", { status: 400 });
    const messages: readonly unknown[] = body.messages;
    const user = messages.findLast(message =>
      Boolean(message && typeof message === "object" && "role" in message && message.role === "user"));
    const input = JSON.stringify(user && typeof user === "object" && "content" in user ? user.content ?? null : null);
    const prompt = input.includes(oldPrompt) ? oldPrompt : input.includes(newPrompt) ? newPrompt : undefined;
    if (!prompt) return new Response("Unexpected provider request", { status: 400 });
    prompts.push(prompt);
    const response = { id: "npm-upgrade-wire", object: "chat.completion.chunk", created: 1, model: "local" };
    const chunks = [
      { index: 0, delta: { role: "assistant", content: prompt === oldPrompt ? oldAnswer : newAnswer }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ];
    return new Response(chunks.map(choice => `data: ${JSON.stringify({ ...response, choices: [choice] })}\n\n`).join("") +
      "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  return { server, prompts };
}

export function upgradeRuntime(options: {
  readonly root: string; readonly env: Record<string, string>; readonly command: string; readonly signal: AbortSignal;
}) {
  const { root, env, command, signal } = options;
  const { server, prompts } = startModel();
  const token = crypto.randomUUID();
  const bridge = startReferenceBridge({ token, ownerChatId: route.chatId, ownerId: route.ownerId, botUserId: route.botUserId });
  const config = join(root, "superagent.json");
  const state = join(root, "state");
  const workspace = join(root, "work");
  const journal = join(state, "sessions", "main", "session.jsonl");
  const host = join(state, "run", "main.sock");
  const receiptPath = `${host}.exit.json`;
  const gateway = join(state, "run", "gateway.sock");
  const cli = (verb: "start" | "stop" | "status") =>
    checked([command, verb, "--config", config], { cwd: workspace, env: { ...env, [tokenEnv]: token },
      ...(verb === "start" ? { timeout: launchTimeout } : {}) });
  const status = async (): Promise<Status | null> => (JSON.parse(await cli("status")) as { gateway: Status | null }).gateway;
  const entries = async (): Promise<Entry[]> => (await readFile(journal, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
  let launch: Promise<string> | undefined;
  let instance: Instance | undefined;
  let stopAttempted = false;
  let closed: Promise<void> | undefined;

  async function configure(omp: string, disabledProviders: readonly string[]) {
    const modelRoles = { default: model, judge: model };
    await privateJson(join(env.PI_CODING_AGENT_DIR, "config.yml"), {
      memory: { backend: "mnemopi" },
      mnemopi: { llmMode: "none", noEmbeddings: true, autoRecall: false, autoRetain: false },
      disabledProviders, modelRoles,
      modelPresets: Object.fromEntries(["high", "middle", "low"].map(name => [name, { modelRoles }])),
    });
    await privateJson(join(env.PI_CODING_AGENT_DIR, "models.yml"), { providers: {
      "upgrade-local": { api: "openai-completions", apiKey: "isolated-loopback", baseUrl: `${server.url.origin}/v1`,
        models: [{ id: "local", name: "Package Upgrade Loopback", contextWindow: 32768, maxTokens: 4096 }] },
    } });
    await privateJson(config, {
      stateDir: state, headCwd: workspace, command: [omp, "--offline"], model,
      maxHosts: 2, maxSubagents: 2, idleMs: 0, headIdleMs: 0,
      kakao: { ...route, tokenEnv, bridgeUrl: bridge.url },
    });
  }

  async function ready() {
    signal.throwIfAborted();
    assert(!closed && !launch, "Previous private Gateway launch is unresolved");
    stopAttempted = false;
    launch = cli("start");
    await launch;
    signal.throwIfAborted();
    let seen: Status | null = null;
    const service = await until("installed Gateway, admission, and HEAD readiness (including managed update)", 60_000, async () => {
      seen = await status();
      if (seen?.gateway.ready && seen.gateway.admissionReady && seen.head.connected && seen.head.ready &&
          seen.head.initialization?.state === "complete" && !seen.ulw.updating) return seen;
    }, signal).catch((cause: unknown) => {
      throw new Error(`Last installed omp-sa status: ${JSON.stringify(seen)}`, { cause });
    });
    const { head } = await headState(host);
    assert.equal(head.adapterProtocol, "owned-stock-stdio-v1");
    assert.equal(head.hostPid, service.head.pid);
    assert.equal(head.sessionId, service.head.initialization?.sessionId);
    assert.equal(await realpath(head.sessionFile), journal);
    assert.notEqual(head.hostPid, head.adapterOwnerPid);
    assert([head.hostPid, head.adapterOwnerPid, service.gateway.pid].every(alive));
    const socket = await privateGatewaySocket(gateway);
    assert(socket, "Ready Gateway did not publish a private socket");
    instance = { head, gatewayPid: service.gateway.pid, socket };
    signal.throwIfAborted();
    return instance;
  }

  async function turn(phase: "old" | "new", head: Head) {
    const [prompt, answer, logId] = phase === "old" ? [oldPrompt, oldAnswer, "101"] : [newPrompt, newAnswer, "102"];
    const previous = new Set((await entries()).map(entry => entry.id));
    // The first real poll baselines at the latest row; wait for that durable
    // baseline before adding test input, not just for Gateway socket readiness.
    await until("authenticated Kakao inbox generation in the durable cursor", 10_000, () => {
      const db = new Database(join(state, "coordination.sqlite"), { readonly: true });
      try {
        db.exec("PRAGMA busy_timeout = 2000");
        const row = db.query<{ readonly generation: string; readonly after: number }, [string]>(
          "SELECT json_extract(value, '$.generation') AS generation, json_extract(value, '$.after') AS after FROM metadata WHERE key = ?",
        ).get(`kakao:${route.botUserId}:${route.chatId}:inbox-cursor`);
        if (row?.generation === bridge.generation && row.after === (phase === "old" ? 0 : 1)) return true;
      } finally { db.close(); }
    }, signal);
    assert.equal(bridge.inject({ logId, text: prompt }), phase === "old" ? 1 : 2);
    await until(`Kakao delivery for the ${phase} installed HEAD`, 30_000, () =>
      bridge.deliveries.find(delivery => delivery.message.includes(answer)), signal);
    assert.deepEqual(prompts, phase === "old" ? [oldPrompt] : [oldPrompt, newPrompt]);
    return until(`settled native observation from the ${phase} installed Host`, 15_000, async () => {
      const observation = (await entries()).find(entry => !previous.has(entry.id) && entry.type === "custom" &&
        entry.customType === "rpc_prompt_result" && entry.data?.hostPid === head.hostPid &&
        entry.data.sessionId === head.sessionId && entry.data.frame?.type === "prompt_result" &&
        entry.data.frame?.status === "completed" && entry.data.frame.agentInvoked === true);
      if (observation && (await headState(host)).isSettled) {
        assert(observation.id && observation.data?.frame?.id, "Observation lacks journal or RPC identity");
        return observation;
      }
    }, signal);
  }

  async function stop(expected: Instance, phase: "old" | "new") {
    assert.equal(expected, instance, "Stop must target the current private Gateway");
    assert(!stopAttempted, "A previous stop attempt is unresolved");
    assert.deepEqual((await headState(host)).head, expected.head, "Live HEAD identity changed before installed stop");
    assert.deepEqual(await privateGatewaySocket(gateway), expected.socket, "Private Gateway socket changed before installed stop");
    signal.throwIfAborted();
    stopAttempted = true;
    const { head, gatewayPid } = expected;
    await cli("stop");
    await until("actual Gateway, native OMP, and Rust owner process exits", 20_000, () =>
      [head.hostPid, head.adapterOwnerPid, gatewayPid].every(pid => !alive(pid)) ? true : undefined);
    assert(!existsSync(host) && !existsSync(gateway), "Graceful stop left an owned socket");
    const receipt = await lstat(receiptPath);
    assert(receipt.isFile() && receipt.uid === process.getuid?.() && (receipt.mode & 0o077) === 0);
    const bytes = await readFile(receiptPath);
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), {
      pid: head.hostPid, ownerPid: head.adapterOwnerPid, sessionId: head.sessionId, sessionFile: head.sessionFile,
      code: 0, signal: null, persisted: true, observationsFlushed: true,
    });
    await writeFile(join(root, `${phase}.exit.json`), bytes, { mode: 0o600, flag: "wx" });
    launch = undefined;
    instance = undefined;
  }

  async function stopForCleanup() {
    if (!launch || stopAttempted) return;
    stopAttempted = true;
    await stopPrivateGateway({ gateway, host, launch, owner: instance && {
      gatewayPid: instance.gatewayPid, socket: instance.socket, hostPids: [instance.head.hostPid, instance.head.adapterOwnerPid],
    } });
  }

  function close() {
    return closed ??= (async () => {
      const [gateway] = await Promise.allSettled([stopForCleanup()]);
      const servers = await Promise.allSettled([bridge.stop(), Promise.resolve().then(() => server.stop(true))]);
      const errors = [gateway, ...servers].flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Private npm upgrade teardown failed");
    })();
  }

  return { configure, status, ready, turn, stop, close, receiptPath,
    entries, config, physicalJournal: async () => {
      const { dev, ino } = await stat(journal, { bigint: true });
      return { dev, ino };
    } };
}
