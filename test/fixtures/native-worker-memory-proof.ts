import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostPaths, type Config } from "../../src/config/config";
import { routeKey, type Lane } from "../../src/contracts";
import { toLane, type LaneRow } from "../../src/lane/lane-rows";
import { HostConnection } from "../../src/omp/host";
import type { workerMemoryStatus } from "../../src/runtime/worker-memory";
import { parseWorkerMemoryPage } from "../../src/worker/worker-memory-page";
import { lookupWorker, workerConnect, workerProbe, workerRef } from "../../src/worker/worker-wire";
import { startGateway } from "../oracles/bun-gateway/gateway";
import { waitForFixtureProcessExit } from "./host-fixture-processes";
import { nativeDisabledProviders } from "./native-extension";
import { offlineMnemopi } from "./native-memory";
import { nativeJournalDispatches } from "./native-tool-transport";
import { DecisionParityMessenger } from "./native-worker-decision-parity";
import { memoryFixture as f, memoryFixtureVectors } from "./native-worker-memory-provider";

function projectBank(root: string): Promise<string> {
  return readdir(join(root, "banks")).then(banks => {
    const [bank] = banks;
    assert(banks.length === 1 && bank, `Expected one native project bank under ${root}`);
    return join(root, "banks", bank, "mnemopi.db");
  });
}

async function page(host: HostConnection, unchanged?: string) {
  const id = crypto.randomUUID();
  const response = await host.request({ type: "get_worker_memory", after: 0, ...(unchanged !== undefined && { unchanged }) }, id);
  expect(response).toMatchObject({ type: "response", id, command: "get_worker_memory", success: true });
  assert(response.success && "data" in response);
  return parseWorkerMemoryPage(response.data, 0);
}

async function embeddingLabels(file: string): Promise<string[]> {
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  return lines.flatMap(line => {
    const labels: string[] = JSON.parse(line);
    return labels;
  }).sort();
}

/** Only the messenger/Gateway wire and model inputs are fixtures; the actual
 * HEAD extension binds the native AgentSession, and its controller pulls from SSH.
 * Do not give the in-process chat-parity controller a synthetic sink. */
export async function verifyNativeWorkerMemory(config: Config, options: {
  readonly workerHome: string; readonly workerCwd: string; readonly workerId: string; readonly path: string;
}): Promise<void> {
  const { workerHome, workerCwd, workerId, path } = options;
  const home = config.stateDir;
  const agent = join(home, ".omp", "agent");
  const memoryRoot = join(agent, "memory");
  const headMarker = join(home, f.directory);
  const workerMarker = join(workerHome, f.directory);
  const release = join(workerMarker, f.release);
  const model = `${f.model.provider}/${f.model.id}`;
  const roles = { default: model, judge: model };
  await Promise.all([mkdir(memoryRoot, { recursive: true, mode: 0o700 }), mkdir(headMarker, { mode: 0o700 })]);
  await writeFile(join(headMarker, f.embeddingMarker), "", { flag: "wx", mode: 0o600 });
  await writeFile(join(agent, "config.yml"), JSON.stringify({
    ...offlineMnemopi,
    mnemopi: {
      ...offlineMnemopi.mnemopi, scoping: "per-project", dbPath: join(memoryRoot, "mnemopi.db"),
      noEmbeddings: false, embeddingModel: f.embeddingModel, polyphonicRecall: false,
    },
    extensions: [join(import.meta.dir, "native-extension.ts")],
    models: { offline: true }, disabledProviders: nativeDisabledProviders, modelRoles: roles,
    // Stock awaits Mnemopi initialization before session_start with autolearn
    // enabled. Keep its private post-turn capture disabled.
    autolearn: { enabled: true, autoContinue: false },
    modelPresets: Object.fromEntries(["high", "middle", "low"].map(name => [name, { modelRoles: roles }])),
  }), { mode: 0o600 });

  const route = { platform: "discord" as const, accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: "51" };
  const messenger = new DecisionParityMessenger();
  messenger.thread = { route, title: "SSH worker project memory", archived: false, requiresTag: false, availableTags: [], appliedTags: [] };
  const errors: unknown[] = [];
  const wait = async (check: () => boolean, label: string) => {
    const deadline = performance.now() + 30_000;
    while (!check()) {
      if (errors.length) throw new AggregateError(errors, label);
      if (performance.now() >= deadline) throw new Error(label);
      await Bun.sleep(25);
    }
  };
  const send = (id: string, text: string) =>
    messenger.deliver({ id, messageId: id, route, text, receivedAt: Date.now(), attachments: [] });
  let head: HostConnection | undefined, worker: HostConnection | undefined, ledger: Database | undefined;
  const laneForRoute = (): Lane | undefined => {
    const row = ledger?.query<LaneRow, [string]>(
      "SELECT data, remote FROM lanes WHERE route_key = ?",
    ).get(routeKey(route));
    return row ? toLane(row) : undefined;
  };
  const memoryStatus = (id: string): ReturnType<typeof workerMemoryStatus> => {
    const row = ledger?.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key = ?")
      .get(`worker-memory:status:${id}`);
    return row ? JSON.parse(row.value) : null;
  };
  const gateway = await startGateway(config, {
    messenger, onError: error => errors.push(error), managedUlwPath: join(import.meta.dir, "managed-super"),
    headEnvironment: { HOME: home, USERPROFILE: home, PATH: path, LC_ALL: "C", PI_CODING_AGENT_DIR: agent, GIT_CONFIG_NOSYSTEM: "1" },
  });
  try {
    await wait(() => gateway.status().head.ready, "The actual HEAD extension did not become ready in the isolated stock Host");
    ledger = new Database(join(home, "coordination.sqlite"), { readonly: true, strict: true });
    const done = ledger.query<{ state: string }, [string]>("SELECT state FROM inputs WHERE id = ?");
    head = await HostConnection.connect(hostPaths(config, "main").socketPath);
    const headState = await head.client.getState();
    expect(headState).toMatchObject({ hostPid: gateway.status().head.pid, sessionFile: hostPaths(config, "main").sessionFile });
    expect(JSON.parse(await readFile(join(headMarker, f.embeddingReady), "utf8"))).toEqual({
      pid: headState.hostPid, sessionId: headState.sessionId, model: f.embeddingModel,
    });
    using headBank = new Database(await projectBank(memoryRoot), { readonly: true });
    const imported = headBank.query<{ id: string; content: string; scope: string; trust: string; cwd: string }, []>(
      "SELECT id, content, scope, trust_tier AS trust, json_extract(metadata_json, '$.cwd') AS cwd"
      + " FROM working_memory WHERE source = 'superagent-worker-fact' ORDER BY rowid",
    );
    const indexed = headBank.query<{ content: string; model: string; embedding: string }, []>(
      "SELECT m.content, e.model, e.embedding_json AS embedding FROM working_memory AS m"
      + " JOIN memory_embeddings AS e ON e.memory_id = m.id WHERE m.source = 'superagent-worker-fact' ORDER BY m.rowid",
    );
    const expectVectors = (facts: readonly (keyof typeof memoryFixtureVectors)[]) =>
      expect(indexed.all()).toEqual(facts.map(content =>
        ({ content, model: f.embeddingModel, embedding: JSON.stringify(memoryFixtureVectors[content]) })));
    const calls = join(headMarker, f.embeddingCalls);
    expect(imported.all()).toEqual([]);
    expectVectors([]);

    await send(f.startId, `/head Start an enrolled remote lane to store the project fixture facts. ${f.start}`);
    const entered = join(workerMarker, f.entered);
    await wait(() => {
      const launch = done.get(f.startId)?.state;
      const handoff = done.get(`handoff:${f.startId}:lane`)?.state;
      if (launch === "uncertain" || launch === "cancelled" || handoff === "uncertain" || handoff === "cancelled") {
        throw new Error(`The native memory opening turn failed (HEAD ${launch}, worker handoff ${handoff})`);
      }
      return existsSync(entered);
    }, "Worker never completed native retain/learn and entered the held turn");
    const lane = laneForRoute();
    assert(lane?.remote && lane.sessionId && lane.pid, "No authenticated remote lane owns the held native turn");
    expect(lane).toMatchObject({ generation: 1, cwd: config.headCwd, remote: { workerId } });
    const registration = await lookupWorker(home, lane.remote);
    const ref = workerRef(lane);
    expect(await workerProbe(registration, ref)).toMatchObject({
      memoryPreparedVersion: 1, memorySyncVersion: 1, uncertain: false, socket: true, pidAlive: true, ownerAlive: true, sessionFile: true,
      pid: lane.pid, sessionId: lane.sessionId,
    });
    worker = await workerConnect(registration, ref);
    expect(await readFile(entered, "utf8")).toBe(String(lane.pid));
    expect(await worker.client.getState()).toMatchObject({ hostPid: lane.pid, sessionId: lane.sessionId, isSettled: false });
    expect(await worker.request({ type: "get_worker_memory", after: 0 })).toMatchObject({ success: false, code: "session_busy" });
    expect(imported.all()).toEqual([]);
    expect(existsSync(calls)).toBe(false);

    const memoryDirs = (await readdir(dirname(lane.sessionFile))).filter(name => name.startsWith("memory-"));
    const [memoryDir] = memoryDirs;
    assert(memoryDirs.length === 1 && memoryDir, "Expected one fresh lane-owned worker memory directory");
    const privateMemory = join(dirname(lane.sessionFile), memoryDir);
    const workerBankPath = await projectBank(privateMemory);
    expect((await stat(privateMemory)).mode & 0o777).toBe(0o700);
    expect((await stat(workerBankPath)).mode & 0o777).toBe(0o600);
    {
      using workerBank = new Database(workerBankPath, { readonly: true });
      expect(workerBank.query(`SELECT content, source, json_extract(metadata_json, '$.cwd') AS cwd,
        json_extract(metadata_json, '$.session_id') AS sessionId FROM working_memory ORDER BY rowid`).all()).toEqual([
        { content: f.retained, source: "coding-agent-retain", cwd: workerCwd, sessionId: lane.sessionId },
        { content: f.learned, source: "coding-agent-learn", cwd: workerCwd, sessionId: lane.sessionId },
      ]);
    }

    await writeFile(release, "", { mode: 0o600 });
    await wait(() => {
      const status = memoryStatus(lane.id);
      return status?.status === "checked" && status.inserted === 2 && status.indexed === 2;
    }, "HEAD did not import and index the settled retain/learn page");
    expect(memoryStatus(lane.id)).toMatchObject({
      generation: lane.generation, status: "checked", cursor: 0, records: 2, inserted: 2, skipped: 0, rejected: 0,
      lexical: 2, indexed: 2, disabled: 0, pending: 0,
    });
    const first = await page(worker);
    expect(first.next).toBe(0);
    expect(first.records.map(row => row.content)).toEqual([f.retained, f.learned]);
    expect(await page(worker)).toEqual(first);
    expect(await page(worker, first.stamp)).toEqual({ after: 0, next: 0, records: [], stamp: first.stamp });
    const initialIds = imported.all().map(row => row.id);
    expect(new Set(initialIds).size).toBe(2);
    expectVectors([f.retained, f.learned]);
    expect(await embeddingLabels(calls)).toEqual(["learn", "retain"]);

    // Let idle eviction finish instead of racing the next input against it.
    // A new owner must continue the same journal, not recreate its imported facts.
    await worker.close();
    worker = undefined;
    await wait(() => laneForRoute()?.pid === null, "The first worker generation was not released after idle eviction");
    expect(laneForRoute()).toMatchObject({
      sessionId: lane.sessionId, sessionFile: lane.sessionFile, generation: lane.generation, runtimeState: "unloaded",
    });
    expect(await workerProbe(registration, ref)).toMatchObject({
      exitGeneration: lane.generation, uncertain: false, socket: false, pidAlive: false, ownerAlive: false,
      pid: null, sessionFile: true, sessionId: lane.sessionId,
    });

    const resumedGeneration = lane.generation + 1;
    await send(f.extendId, `In this same lane, learn the final project fact. ${f.extend}`);
    await wait(() => done.get(f.extendId)?.state === "done"
      && messenger.sent.some(output => output.sourceId === f.extendId && output.text === f.laterReport),
      "The bound remote lane did not deliver the follow-up");
    expect(messenger.sent.filter(output => output.sourceId === f.extendId && output.text === f.laterReport))
      .toEqual([expect.objectContaining({ route })]);
    expect(laneForRoute()).toMatchObject({
      sessionId: lane.sessionId, sessionFile: lane.sessionFile, generation: resumedGeneration, remote: lane.remote,
    });
    await wait(() => {
      const status = memoryStatus(lane.id);
      return status?.status === "checked" && status.generation === resumedGeneration && status.skipped === 2 && status.indexed === 3;
    }, "HEAD did not replay the changed page without duplicating existing facts");
    expect(memoryStatus(lane.id)).toMatchObject({
      generation: resumedGeneration, status: "checked", cursor: 0, records: 3, inserted: 1, skipped: 2, rejected: 0,
      lexical: 3, indexed: 3, disabled: 0, pending: 0,
    });
    const allRows = imported.all();
    expect(allRows.slice(0, 2).map(row => row.id)).toEqual(initialIds);
    expect(allRows.map(({ id: _id, ...row }) => row)).toEqual([f.retained, f.learned, f.later].map(content =>
      ({ content, scope: "bank", trust: "IMPORTED", cwd: config.headCwd })));
    await wait(() => laneForRoute()?.pid === null, "The replayed lane was not positively released after idle eviction");
    const facts = [f.retained, f.learned, f.later] as const;
    expectVectors(facts);
    expect(await embeddingLabels(calls)).toEqual(["follow-up", "learn", "retain"]);

    await send(f.recallId, `/head Recall from the native project bank using the fixture's unrelated search terms. ${f.recall}`);
    await wait(() => messenger.sent.some(output => output.sourceId === f.recallId && output.text === f.recallReply),
      "Native HEAD did not settle its real recall tool turn");
    const journal = await head.request({ type: "get_entries" });
    assert(journal.success && journal.command === "get_entries", "The actual HEAD journal is unavailable");
    const recalls = nativeJournalDispatches(journal.data.entries).filter(call => call.name === "recall" && call.mode === "execute");
    expect(recalls.map(call => ({ ok: call.ok, args: call.args }))).toEqual([{ ok: true, args: { query: f.query } }]);
    const content = recalls[0]?.result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    for (const fact of facts) expect(content).toContain(fact);
    expect(content).not.toContain(f.unshared);
    expect(await embeddingLabels(calls)).toEqual(["follow-up", "learn", "recall", "retain"]);
  } finally {
    await writeFile(release, "", { mode: 0o600 });
    try {
      await worker?.close();
      // Only the exact enrolled native generation from this fixture may be
      // stopped on a failure path; an already evicted generation needs no RPC.
      const lane = laneForRoute();
      if (lane?.remote && lane.pid) {
        const registration = await lookupWorker(home, lane.remote);
        const ref = workerRef(lane);
        const probe = await workerProbe(registration, ref);
        if (probe.socket && probe.pid === lane.pid && probe.sessionId === lane.sessionId) {
          const owner = await workerConnect(registration, ref);
          try {
            const state = await owner.client.getState();
            expect(state).toMatchObject({ hostPid: lane.pid, sessionId: lane.sessionId });
            if (!state.isSettled) await owner.client.abortAndRestoreQueue();
            expect(await owner.request({ type: "shutdown_host" })).toMatchObject({ success: true });
            await owner.exited;
            await waitForFixtureProcessExit([state.hostPid, state.adapterOwnerPid]);
          } finally { await owner.close(); }
        }
      }
    } finally {
      ledger?.close();
      try { await gateway.stop(); }
      finally {
        await gateway.close();
        await head?.close();
      }
    }
  }
}
