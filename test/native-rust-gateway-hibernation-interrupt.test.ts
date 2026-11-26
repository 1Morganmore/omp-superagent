import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import { loadConfig } from "../src/config/config";
import type { GatewayStatus } from "../src/gateway/gateway-wire";
import { assertResidentFixtureOwner, fixtureHostLaunches } from "./fixtures/host-fixture-processes";
import { assertRestoredSelection, assertSameSession, configureIdleHead, headIdleMs, waitForDormantHead } from "./fixtures/native-head-hibernation";
import { until } from "./fixtures/native-rust-gateway";
import {
  headInput, ledger, meta, sendReceipts, verifyDelivery, verifyTranscript, withNativeRustGateway, type NativeRustGateway,
} from "./fixtures/native-rust-gateway-assertions";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;
type LaunchReceipt = {
  readonly id: string;
  readonly mode: "hibernate";
  readonly stage: string;
  readonly replacementOwnerPid: number | null;
  readonly replacementSessionId: string | null;
  readonly resumeProfileHash?: string;
};

function checkpoint(fixture: NativeRustGateway): LaunchReceipt {
  const value = ledger(fixture, db => meta(db, "gateway:head-rotation"));
  assert(value, "Missing durable HEAD hibernation plan");
  return JSON.parse(value);
}

async function retireHead(fixture: NativeRustGateway) {
  await configureIdleHead(fixture);
  const original = await fixture.start();
  const first = headInput("850");
  await fixture.deliver(first);
  assert.equal(await verifyDelivery(fixture, first), "HEAD:850");
  const selection = await fixture.observeModel();
  const planId = await waitForDormantHead(fixture, original);
  await fixture.stop(original);
  const retired = checkpoint(fixture);
  assert.equal(retired.id, planId);
  assert.equal(retired.stage, "complete");
  assert.equal(retired.resumeProfileHash, undefined, "Explicit stop must retire the automatic wake authority");
  assert.equal(retired.replacementOwnerPid, null);
  // The new Gateway uses its own config; do not start another sleep cycle.
  const config = await loadConfig(fixture.config);
  await writeFile(fixture.config, JSON.stringify({ ...config, headIdleMs: 0 }));
  return { original, first, planId, selection };
}

async function reservedOwner(fixture: NativeRustGateway, planId: string, sessionId: string) {
  const owner = await until(async () => {
    const plan = checkpoint(fixture);
    if (plan.stage !== "launching" || !plan.replacementOwnerPid) return;
    assert.equal(plan.id, planId);
    assert.equal(plan.mode, "hibernate");
    assert.equal(plan.replacementSessionId, sessionId);
    const ownerPid = plan.replacementOwnerPid;
    const entered = join(fixture.root, `entered-head-start.${ownerPid}`);
    if (!existsSync(entered)) return;
    const nativePid = Number(await readFile(entered, "utf8"));
    // The marker may be visible during its one short write.
    if (nativePid === 0) return;
    assert(Number.isSafeInteger(nativePid) && nativePid > 1, `Invalid native fixture PID: ${nativePid}`);
    return { ownerPid, nativePid };
  }, "durable launching reservation and real stock HEAD held before identification");
  await assertResidentFixtureOwner(fixture.root, owner);
  return owner;
}

function assertUnpublished(status: GatewayStatus, gatewayPid: number): void {
  assert.equal(status.gateway.pid, gatewayPid);
  assert.equal(status.gateway.ready, true, "The Gateway remains available for operator commands");
  assert.equal(status.gateway.admissionReady, false);
  assert.equal(status.head.hibernation?.stage, "launching");
  assert.equal(status.head.pid, null);
  assert.equal(status.head.ready, false);
  assert.equal(status.head.connected, false);
}

nativeTest("fresh start keeps a retired HEAD checkpoint unpublished and stoppable if config drifts after spawn", () =>
  withNativeRustGateway(async fixture => {
    const { original, first, planId } = await retireHead(fixture);
    const config = await loadConfig(fixture.config);
    const release = join(fixture.root, "release-head-start");
    await writeFile(join(fixture.root, "hold-head-start"), "", { mode: 0o600, flag: "wx" });
    const gatewayPid = fixture.launchGateway();
    const pending = headInput("851");
    let owner: Awaited<ReturnType<typeof reservedOwner>>;
    let inbox: string;
    try {
      owner = await reservedOwner(fixture, planId, original.head.sessionId);
      const status = await fixture.status();
      assertUnpublished(status, gatewayPid);
      assert.equal(existsSync(status.head.socketPath), false, "Config must change before native identification");
      inbox = await fixture.stageInput(pending);
      // Even an otherwise rollout-compatible idle setting change must fail
      // closed once this exact Gateway already reserved the launch.
      const next = join(fixture.root, "next-config.json");
      await writeFile(next, JSON.stringify({ ...config, headIdleMs: 20_000 }), { mode: 0o600 });
      await rename(next, fixture.config);
    } finally { await writeFile(release, "", { mode: 0o600 }); }

    await until(async () => {
      const status = await fixture.status();
      assertUnpublished(status, gatewayPid);
      const socket = statSync(status.head.socketPath, { throwIfNoEntry: false });
      if (status.head.error && socket?.isSocket() && (socket.mode & 0o777) === 0o600) return status;
    }, "observable publication refusal with the exact native owner still held");
    const head = await fixture.snapshot("settled");
    assert.deepEqual({ ownerPid: head.ownerPid, nativePid: head.pid }, owner);
    assertSameSession(head, original.head);
    assert.equal(checkpoint(fixture).replacementOwnerPid, owner.ownerPid);
    assert.equal(ledger(fixture, db => meta(db, "gateway:head")), "null");
    assert(existsSync(inbox), "The fresh approval barrier must not acknowledge the staged input");
    assert.deepEqual((await sendReceipts(fixture)).map(row => row.output.sourceId), [first.id]);
    await fixture.stop({ head, gatewayPid });
    assert.equal((await fixtureHostLaunches(fixture.root)).length, 2, "Stop must not relaunch a held owner");
    assert.equal(checkpoint(fixture).replacementOwnerPid, null);
    assert(existsSync(inbox), `Stop must not consume ${pending.id}`);
    await verifyTranscript(fixture, [original.head, head], [first.id]);
  }), 120_000);

nativeTest("restoring the reserved configuration releases the same waking controller and its queued input exactly once", () =>
  withNativeRustGateway(async fixture => {
    await configureIdleHead(fixture);
    const bytes = await readFile(fixture.config);
    const original = await fixture.start();
    const id = await waitForDormantHead(fixture, original);
    await writeFile(join(fixture.root, "hold-head-start"), "", { mode: 0o600, flag: "wx" });
    const pending = headInput("856");
    await fixture.deliver(pending);
    const owner = await reservedOwner(fixture, id, original.head.sessionId);
    try {
      await writeFile(fixture.config, JSON.stringify({ ...JSON.parse(bytes.toString()), headIdleMs: 0 }));
    } finally { await writeFile(join(fixture.root, "release-head-start"), "", { mode: 0o600 }); }
    await until(async () => {
      const status = await fixture.status();
      if (!existsSync(status.head.socketPath) || !status.head.error) return;
      assert.equal(status.gateway.admissionReady, true);
      assert.equal(status.head.hibernation?.stage, "launching");
      assert.equal(status.head.ready, false);
      assert.equal(status.head.pid, null);
      return true;
    }, "wake held without releasing queued work under the changed config");
    const replacement = join(fixture.root, "restored-config.json");
    await writeFile(replacement, bytes);
    await rename(replacement, fixture.config);
    assert.equal(await verifyDelivery(fixture, pending), "HEAD:856");
    const resumed = await fixture.ready(original.gatewayPid);
    assert.deepEqual([resumed.head.pid, resumed.head.ownerPid], [owner.nativePid, owner.ownerPid]);
    assertSameSession(resumed.head, original.head);
    assert.equal((await fixtureHostLaunches(fixture.root)).length, 2);
    await fixture.stop(resumed);
    await verifyTranscript(fixture, [original.head, resumed.head], [pending.id]);
  }), 120_000);

nativeTest("fresh Gateway adopts the exact unpublished HEAD owner after the starting Gateway crashes", () =>
  withNativeRustGateway(async fixture => {
    const { original, first, planId, selection } = await retireHead(fixture);
    const release = join(fixture.root, "release-head-start");
    await writeFile(join(fixture.root, "hold-head-start"), "", { mode: 0o600, flag: "wx" });
    const lostGatewayPid = fixture.launchGateway();
    const pending = headInput("852");
    let owner: Awaited<ReturnType<typeof reservedOwner>>;
    let gatewayPid: number;
    try {
      owner = await reservedOwner(fixture, planId, original.head.sessionId);
      const status = await fixture.status();
      assertUnpublished(status, lostGatewayPid);
      assert.equal(existsSync(status.head.socketPath), false);
      await fixture.stageInput(pending);
      await fixture.crashGateway(lostGatewayPid);
      await assertResidentFixtureOwner(fixture.root, owner);
      gatewayPid = fixture.launchGateway();
      assert.notEqual(gatewayPid, lostGatewayPid);
      // Force the new Gateway's initial probe to fail while the native socket
      // is absent, before allowing stock OMP's first attach to the new peer.
      await until(async () => {
        const value = ledger(fixture, db => meta(db, "gateway:socket"));
        if (!value || JSON.parse(value).pid !== gatewayPid) return;
        const current = await fixture.status();
        if (!current.gateway.ready) return;
        assertUnpublished(current, gatewayPid);
        assert.equal(existsSync(current.head.socketPath), false);
        if (current.head.error) return current;
      }, "new Gateway's initial probe held before the original owner is identifiable");
      assert.equal(checkpoint(fixture).replacementOwnerPid, owner.ownerPid);
    } finally { await writeFile(release, "", { mode: 0o600 }); }

    const resumed = await fixture.ready(gatewayPid);
    assert.deepEqual({ ownerPid: resumed.head.ownerPid, nativePid: resumed.head.pid }, owner);
    assertSameSession(resumed.head, original.head);
    assertRestoredSelection(await fixture.observeModel(), selection);
    assert.equal(await verifyDelivery(fixture, pending), "HEAD:852");
    assert.deepEqual((await sendReceipts(fixture)).map(row => row.output.sourceId), [first.id, pending.id]);
    await fixture.stop(resumed);
    assert.equal((await fixtureHostLaunches(fixture.root)).length, 2, "Recovery must adopt, not launch another HEAD");
    await verifyTranscript(fixture, [original.head, resumed.head], [first.id, pending.id]);
  }), 120_000);

nativeTest("a waking HEAD which starts before the successor Gateway reconnects and answers its queued input exactly once", () =>
  withNativeRustGateway(async fixture => {
    await configureIdleHead(fixture);
    const first = await fixture.start();
    const planId = await waitForDormantHead(fixture, first);
    const pending = headInput("853");
    await writeFile(join(fixture.root, "hold-head-start"), "", { mode: 0o600, flag: "wx" });
    let owner: Awaited<ReturnType<typeof reservedOwner>>;
    try {
      await fixture.deliver(pending);
      owner = await reservedOwner(fixture, planId, first.head.sessionId);
      await fixture.crashGateway(first.gatewayPid);
    } finally { await writeFile(join(fixture.root, "release-head-start"), "", { mode: 0o600 }); }

    // The previous test holds this very socket until the successor is ready.
    // Here the native Host must finish starting without any running Gateway.
    await until(() => {
      const socket = statSync(join(fixture.root, "run/main.sock"), { throwIfNoEntry: false });
      return socket?.isSocket() && (socket.mode & 0o777) === 0o600 || undefined;
    }, "reserved HEAD socket available without a Gateway");
    const unattended = await fixture.snapshot("settled");
    assert.deepEqual([unattended.pid, unattended.ownerPid], [owner.nativePid, owner.ownerPid]);
    await writeFile(join(fixture.root, "hold-adapter-start"), "", { mode: 0o600, flag: "wx" });
    const gatewayPid = fixture.launchGateway();
    try {
      await until(() => existsSync(join(fixture.root, "entered-adapter-start")) || undefined,
        "successor waiting for messenger authentication");
      assert(!existsSync(join(fixture.root, "run/gateway.sock")), "An unauthenticated Gateway must not accept the surviving controller");
      assert.equal(checkpoint(fixture).stage, "launching");
    } finally { await writeFile(join(fixture.root, "release-adapter-start"), "", { mode: 0o600 }); }
    const resumed = await fixture.ready(gatewayPid);
    assert.deepEqual(resumed.head, unattended);
    assertSameSession(resumed.head, first.head);
    assert.equal(await verifyDelivery(fixture, pending), "HEAD:853");
    assert.equal((await fixtureHostLaunches(fixture.root)).length, 2);
    await fixture.stop(resumed);
    await verifyTranscript(fixture, [first.head, unattended], [pending.id]);
  }), 120_000);

nativeTest("a HEAD restored through a journal symlink stays available after its idle window", () =>
  withNativeRustGateway(async fixture => {
    await configureIdleHead(fixture);
    const sessionId = crypto.randomUUID();
    const journal = join(fixture.root, "original-session.jsonl");
    await mkdir(dirname(fixture.sessionFile), { recursive: true, mode: 0o700 });
    await writeFile(journal, JSON.stringify({ type: "session", version: 3, id: sessionId,
      timestamp: new Date().toISOString(), cwd: (await loadConfig(fixture.config)).headCwd }) + "\n", { mode: 0o600 });
    await symlink(journal, fixture.sessionFile);
    const original = await fixture.start();
    assert.equal(original.head.sessionId, sessionId);
    const through = performance.now() + 2 * headIdleMs + 1_250;
    await until(async () => {
      const { head } = await fixture.status();
      assert.equal(head.pid, original.head.pid);
      assert.equal(head.hibernation, undefined, "The original Host must not be asked to exit");
      return performance.now() >= through || undefined;
    }, "a symlink-backed session remaining resident across idle probes");
    assert((await lstat(fixture.sessionFile)).isSymbolicLink());
    const input = headInput("854");
    await fixture.deliver(input);
    assert.equal(await verifyDelivery(fixture, input), "HEAD:854");
    assert.deepEqual(await fixture.snapshot("settled"), original.head);
    await fixture.stop(original);
  }), 120_000);

nativeTest("a rejected native profile stays parked without launch probes until the same daemon sees it restored", () =>
  withNativeRustGateway(async fixture => {
    await configureIdleHead(fixture);
    const config = await loadConfig(fixture.config);
    const probeLog = join(fixture.root, "wake-probes.log");
    const wrapper = join(fixture.root, "count-stock-probes");
    const [stock, ...args] = config.command;
    assert(stock);
    await writeFile(join(fixture.root, "stock-executable"), `${stock}\n`, { mode: 0o600 });
    await writeFile(wrapper, `#!/bin/sh
set -eu
IFS= read -r stock < "$OMP_TEST_HOST_FIXTURE_ROOT/stock-executable"
if [ "$1" = "--version" ]; then
  printf 'probe\\n' >> "$OMP_TEST_HOST_FIXTURE_ROOT/wake-probes.log"
fi
exec "$stock" "$@"
`, { mode: 0o700 });
    await writeFile(fixture.config, JSON.stringify({ ...config, command: [wrapper, ...args] }));
    const original = await fixture.start();
    await waitForDormantHead(fixture, original);
    await fixture.crashGateway(original.gatewayPid);

    const other = join(fixture.root, "other-agent");
    await mkdir(other, { mode: 0o700 });
    for (const name of ["config.yml", "models.yml"]) {
      await copyFile(join(fixture.root, "agent", name), join(other, name));
    }
    const foreignGateway = fixture.launchGateway(other);
    await until(async () => {
      const saved = ledger(fixture, db => meta(db, "gateway:socket"));
      if (!saved || JSON.parse(saved).pid !== foreignGateway) return;
      const status = await fixture.status();
      assert.equal(status.head.pid, null);
      assert.equal(status.gateway.admissionReady, false);
      return status.head.error && status.head.hibernation?.stage === "sleeping" || undefined;
    }, "profile mismatch before publication or dispatch");
    assert.equal((await fixtureHostLaunches(fixture.root)).length, 1);
    assert(!(await readdir(other, { recursive: true })).some(name => name.includes(original.head.sessionId)),
      "Refusing after publishing a discovery link into the other profile is too late");
    const rejectedProbes = await readFile(probeLog, "utf8");
    await Bun.sleep(3_200); // Several actual supervisor ticks with the admission barrier closed.
    assert.equal(await readFile(probeLog, "utf8"), rejectedProbes, "A stable refusal must not re-run stock launch probes");
    assert.equal((await fixture.status()).gateway.admissionReady, false);

    await rename(other, join(fixture.root, "refused-agent"));
    await symlink(join(fixture.root, "agent"), other);
    const resumed = await fixture.ready(foreignGateway);
    assertSameSession(resumed.head, original.head);
    const input = headInput("855");
    await fixture.deliver(input);
    assert.equal(await verifyDelivery(fixture, input), "HEAD:855");
    await fixture.stop(resumed);
    await verifyTranscript(fixture, [original.head, resumed.head], [input.id]);
  }), 120_000);
