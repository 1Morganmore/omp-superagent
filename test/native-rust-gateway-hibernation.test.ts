import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "bun:test";
import { HostConnection } from "../src/omp/host";
import { assertResidentFixtureOwner, fixtureHostLaunches, waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";
import { assertRestoredSelection, assertSameSession, configureIdleHead, headIdleMs, waitForDormantHead } from "./fixtures/native-head-hibernation";
import { until } from "./fixtures/native-rust-gateway";
import {
  headInput, input, ledger, meta, sendReceipts, verifyDelivery, verifyTranscript, withNativeRustGateway,
} from "./fixtures/native-rust-gateway-assertions";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

nativeTest.each([
  { label: "expired resident deadline", residentArgs: ["--max-time=1s"], adoptingArgs: [] },
  { label: "adopting deadline", residentArgs: [], adoptingArgs: ["--max-time=2m"] },
])("an adopted HEAD stays resident instead of changing --max-time ($label)", ({ residentArgs, adoptingArgs }) =>
  withNativeRustGateway(async fixture => {
    const { loadConfig } = await import("../src/config/config");
    const config = await loadConfig(fixture.config);
    await writeFile(fixture.config, JSON.stringify({
      ...config, headIdleMs, command: [...config.command, ...residentArgs],
    }));
    const original = await fixture.start();
    await fixture.crashGateway(original.gatewayPid);
    await writeFile(fixture.config, JSON.stringify({
      ...config, headIdleMs, command: [...config.command, ...adoptingArgs],
    }));
    const adopted = await fixture.start();
    assert.deepEqual(adopted.head, original.head, "The new Gateway must adopt the original native process");
    const idleThrough = performance.now() + headIdleMs + 1_500;
    await until(async () => {
      const { gateway, head } = await fixture.status();
      assert.equal(gateway.pid, adopted.gatewayPid);
      assert.equal(head.pid, original.head.pid);
      assert.equal(head.ready, true);
      assert.equal(head.hibernation, undefined, "Hibernation must neither rearm nor discard an unproved deadline");
      return performance.now() >= idleThrough ? true : undefined;
    }, "adopted HEAD retaining its launch deadline policy");
    assert.deepEqual(await fixture.snapshot("settled"), original.head);
    await fixture.stop(adopted);
  }), 120_000);

nativeTest("a pinned bootstrap model sleeps before the first turn and wakes for that turn", () =>
  withNativeRustGateway(async fixture => {
    const { loadConfig } = await import("../src/config/config");
    const config = await loadConfig(fixture.config);
    await writeFile(fixture.config, JSON.stringify({
      ...config, headIdleMs, command: [...config.command, "--model", "gateway-native/local"],
    }));
    const original = await fixture.start();
    const selection = await fixture.observeModel();
    assert.deepEqual(selection.model, { provider: "gateway-native", id: "local" });
    await waitForDormantHead(fixture, original);
    // No tier override was journaled before the first turn. A newly paid
    // profile default must neither apply to this session nor strand its wake.
    const settingsPath = join(fixture.root, "agent", "config.yml");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    await writeFile(settingsPath, JSON.stringify({ ...settings, tier: { ...settings.tier, openai: "priority" } }));
    const first = headInput("812");
    await fixture.deliver(first);
    assert.equal(await verifyDelivery(fixture, first), "HEAD:812");
    const awakened = await fixture.ready(original.gatewayPid);
    assertSameSession(awakened.head, original.head);
    assertRestoredSelection(await fixture.observeModel(), selection);
    const { connection } = await HostConnection.open(join(fixture.root, "run", "main.sock"));
    try { assert.deepEqual((await connection.client.getState()).serviceTier, {}); }
    finally { await connection.close(); }
    assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).tier.openai, "priority");
    await fixture.stop(awakened);
    await verifyTranscript(fixture, [original.head, awakened.head], [first.id]);
  }), 120_000);

nativeTest("an authenticated reconnect wakes dormant HEAD to recover history without a later live message", () =>
  withNativeRustGateway(async fixture => {
    await configureIdleHead(fixture);
    const original = await fixture.start();
    const before = headInput("810");
    await fixture.deliver(before);
    assert.equal(await verifyDelivery(fixture, before), "HEAD:810");
    await waitForDormantHead(fixture, original);

    const missed = headInput("811");
    await writeFile(join(fixture.root, "offline-history.json"), JSON.stringify({ after: before.messageId, message: missed }));
    const staged = join(fixture.root, "staged-reconnect");
    await writeFile(staged, JSON.stringify({ kind: "reconnect", historyRecovery: true }));
    await rename(staged, join(fixture.root, "adapter-inbox.json"));
    const reply = await until(async () => (await sendReceipts(fixture)).find(row => row.output.sourceId === missed.id),
      "reply to history-only owner message");
    assert.equal(reply.output.text, "HEAD:811");
    assert.deepEqual(reply.output.route, missed.route);
    const awakened = await fixture.ready(original.gatewayPid);
    assertSameSession(awakened.head, original.head);
    await fixture.stop(awakened);
    await verifyTranscript(fixture, [original.head, awakened.head], [before.id, missed.id]);
  }), 120_000);

nativeTest("native Gateway sleeps only after HEAD settles, wakes once with ordered replies, and stays stopped when dormant", () =>
  withNativeRustGateway(async fixture => {
    const { loadConfig: readInitialConfig } = await import("../src/config/config");
    const initialConfig = await readInitialConfig(fixture.config);
    const launchModel = { provider: "gateway-native", id: "local" };
    await writeFile(fixture.config, JSON.stringify({
      ...initialConfig, headIdleMs,
      command: [...initialConfig.command, "--model", `${launchModel.provider}/${launchModel.id}`],
    }));
    const first = await fixture.start();
    assert.deepEqual((await fixture.observeModel()).model, launchModel);
    const select = input("801", "/model gateway-native/alternate");
    await fixture.deliver(select);
    await verifyDelivery(fixture, select);
    const selection = await fixture.observeModel();
    assert.deepEqual(selection.head, first.head);
    assert.deepEqual(selection.model, { provider: "gateway-native", id: "alternate" },
      "The expected selection must differ from the launch default");

    // This starts on a genuinely resident HEAD and holds at the mock provider
    // while the real idle threshold plus one Gateway supervision tick elapse.
    const warm = headInput("207");
    await fixture.deliver(warm);
    await until(() => existsSync(join(fixture.root, "entered-207")) || undefined, "held stock HEAD turn");
    assert.deepEqual(await fixture.snapshot("streaming"), first.head);
    const occupiedThrough = performance.now() + headIdleMs + 1_250;
    await until(async () => {
      const { head } = await fixture.status();
      assert.equal(head.pid, first.head.pid);
      assert.equal(head.hibernation, undefined, "An unsettled model turn must prevent the sleep plan");
      return performance.now() >= occupiedThrough ? true : undefined;
    }, "HEAD remaining resident through the idle window with live work");
    await fixture.releaseBusy();
    assert.equal(await verifyDelivery(fixture, warm), "HEAD:207");
    assert.deepEqual(await fixture.snapshot("settled"), first.head);

    const journal = await readFile(first.head.sessionFile);
    const { dev, ino } = await stat(first.head.sessionFile);
    const assertOriginalJournal = async () => {
      const live = await stat(first.head.sessionFile);
      assert.deepEqual([live.dev, live.ino], [dev, ino], "The native journal must remain the same file");
      assert.deepEqual((await readFile(first.head.sessionFile)).subarray(0, journal.length), journal,
        "The warm history must remain intact on disk through sleep and wake");
    };
    const firstSleep = await waitForDormantHead(fixture, first);
    await assertOriginalJournal();
    // Cross an ordinary supervision tick with no ingress. A momentarily absent
    // HEAD which automatically reappears is not a dormant HEAD.
    const dormantThrough = performance.now() + 1_250;
    await until(async () => {
      const { gateway, head } = await fixture.status();
      assert.equal(gateway.pid, first.gatewayPid);
      assert.equal(head.pid, null);
      assert.equal(head.hibernation?.id, firstSleep);
      assert.equal(head.hibernation?.stage, "sleeping");
      return performance.now() >= dormantThrough ? true : undefined;
    }, "HEAD staying dormant without ingress");
    assert.equal((await fixtureHostLaunches(fixture.root)).length, 1, "Sleep must not eagerly start a successor");
    const wake = headInput("802");
    await fixture.deliver(wake);
    assert.equal(await verifyDelivery(fixture, wake), "HEAD:802");
    const second = await fixture.ready(first.gatewayPid);
    assertSameSession(second.head, first.head);
    assertRestoredSelection(await fixture.observeModel(), selection);
    await assertOriginalJournal();

    // Hold stock disposal after guarded shutdown, not before the idle check.
    // Distinct physical routes prevent same-route steering from folding the
    // separate owner requests into a single native turn.
    const suffix = `head-shutdown.${second.head.pid}`;
    const wave = [
      headInput("803"),
      input("804", "/head Native lifecycle request 804", { ...wake.route, threadId: "50" }),
      input("805", "/head Native lifecycle request 805", { ...wake.route, threadId: "51" }),
    ];
    const release = join(fixture.root, `release-${suffix}`);
    const beforeWave = await fixtureHostLaunches(fixture.root);
    assert.equal(beforeWave.length, 2);
    await writeFile(join(fixture.root, `hold-${suffix}`), "", { mode: 0o600, flag: "wx" });
    try {
      await until(() => existsSync(join(fixture.root, `entered-${suffix}`)) || undefined,
        "stock HEAD disposal in the real hibernation transition");
      const stopping = await fixture.status();
      assert.equal(stopping.head.hibernation?.stage, "stopping");
      assert.equal(stopping.gateway.admissionReady, true);
      await assertResidentFixtureOwner(fixture.root, { nativePid: second.head.pid, ownerPid: second.head.ownerPid });
      // Each offline adapter ACK follows a durable insert; none of the burst
      // has dispatched when the next is admitted. Include exact redelivery.
      for (const event of [...wave, wave[0]]) await fixture.deliver(event);
      const pending = ledger(fixture, db => db.query<{ identity: string; attempted_at: number | null }, []>(
        "SELECT identity,attempted_at FROM gateway_events WHERE delivered_at IS NULL AND identity LIKE 'message:%' ORDER BY sequence").all());
      assert.deepEqual(pending, wave.map(event => ({ identity: `message:${event.id}`, attempted_at: null })));
      assert.deepEqual(await fixtureHostLaunches(fixture.root), beforeWave, "No overlapping successor during shutdown");
    } finally { await writeFile(release, "", { mode: 0o600 }); }

    for (const event of wave) assert.equal(await verifyDelivery(fixture, event), `HEAD:${event.id}`);
    const third = await fixture.ready(first.gatewayPid);
    await waitForFixtureProcessExit([second.head.pid, second.head.ownerPid]);
    assertSameSession(third.head, second.head);
    assertRestoredSelection(await fixture.observeModel(), selection);
    assert.equal((await fixtureHostLaunches(fixture.root)).length, 3, "The admitted burst must result in just one HEAD launch");
    assert.deepEqual((await sendReceipts(fixture)).map(row => row.output.sourceId),
      [select.id, warm.id, wake.id, ...wave.map(event => event.id)]);
    await assertOriginalJournal();

    await waitForDormantHead(fixture, third);
    const beforeStop = await fixtureHostLaunches(fixture.root);
    await fixture.stop(third);
    assert.deepEqual(await fixtureHostLaunches(fixture.root), beforeStop, "Operator stop must not wake a sleeping HEAD");
    assert.deepEqual(await fixture.detached(), [], "Operator stop must not leave a restart runner or successor");
    await verifyTranscript(fixture, [first.head, second.head, third.head], [warm.id, wake.id, ...wave.map(event => event.id)]);

    const { loadConfig } = await import("../src/config/config");
    const config = await loadConfig(fixture.config);
    assert(config.discord);
    const priorReceipts = await sendReceipts(fixture);
    const manualConfig = {
      ...config, headIdleMs: 0,
      discord: { ...config.discord, requireAddressing: !config.discord.requireAddressing },
    };
    const retired = ledger(fixture, db => meta(db, "gateway:head-rotation"));
    assert(retired);
    await writeFile(fixture.config, JSON.stringify({
      ...manualConfig, command: [...config.command, "--max-time=2m"],
    }));
    const rejectedGateway = fixture.launchGateway();
    await until(async () => {
      if (!existsSync(join(fixture.root, "run/gateway.sock"))) return;
      const status = await fixture.status();
      if (status.gateway.pid !== rejectedGateway) return;
      assert.equal(status.head.pid, null);
      assert.equal(status.gateway.admissionReady, false);
      return status.head.error;
    }, "stopped HEAD restart refusing a new native deadline");
    assert.deepEqual(await fixtureHostLaunches(fixture.root), beforeStop);
    assert.equal(ledger(fixture, db => meta(db, "gateway:head-rotation")), retired);
    await assertOriginalJournal();
    await fixture.crashGateway(rejectedGateway);

    await writeFile(fixture.config, JSON.stringify(manualConfig));
    let sawAdmissionBarrier = false;
    const manual = await fixture.start(status => {
      if (!status.gateway.admissionReady) sawAdmissionBarrier = true;
    });
    assert(sawAdmissionBarrier, "An explicit fresh Gateway start must pass the initial approval barrier");
    assert.notEqual(manual.gatewayPid, first.gatewayPid);
    assertSameSession(manual.head, third.head);
    assertRestoredSelection(await fixture.observeModel(), selection);
    await assertOriginalJournal();
    assert.equal((await fixtureHostLaunches(fixture.root)).length, beforeStop.length + 1);
    await fixture.stop(manual);
    assert.deepEqual(await sendReceipts(fixture), priorReceipts, "A fresh configuration must not replay old-route sends");
    await verifyTranscript(fixture, [first.head, second.head, third.head, manual.head],
      [warm.id, wake.id, ...wave.map(event => event.id)]);
  }), 240_000);
