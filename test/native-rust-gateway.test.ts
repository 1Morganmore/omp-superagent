import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "bun:test";
import type { GatewayRestartRecord } from "../src/contracts";
import { requireGateway } from "../src/gateway/gateway-native";
import type { GatewayStatus } from "../src/gateway/gateway-wire";
import { waitForFixtureProcessExit } from "./fixtures/host-fixture-processes";
import { type Head, until } from "./fixtures/native-rust-gateway";
import {
  headInput, input, ledger, meta, sendReceipts, verifyDelivery, verifyTranscript, withNativeRustGateway, type NativeRustGateway,
} from "./fixtures/native-rust-gateway-assertions";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

function sampleIdleMemory(gatewayPid: number, head: Head): void {
  if (process.env.OMP_TEST_GATEWAY_IDLE_RSS !== "1") return;
  // Sample only after the real Host confirms it is settled. ps's RSS is KiB
  // per process, not heap or unique physical memory. Don't sum or gate it.
  // Compare like-for-like OS, architecture, build profile and stock version.
  const pids = [gatewayPid, head.ownerPid, head.pid];
  const sample = Bun.spawnSync(["/bin/ps", "-o", "pid=", "-o", "rss=", "-p", pids.join(",")]);
  assert.equal(sample.exitCode, 0, sample.stderr.toString());
  const rows = new Map(sample.stdout.toString().trim().split("\n").map(row => {
    const [pid, rss] = row.trim().split(/\s+/).map(Number);
    assert(pid && rss, `Expected a resident process, got ${row}`);
    return [pid, rss] as const;
  }));
  // Darwin top MEM is a footprint reading, not the same metric as ps RSS.
  const footprints = new Map<number, string>();
  if (process.platform === "darwin") {
    const top = Bun.spawnSync(["/usr/bin/top", "-l", "1", "-stats", "pid,mem",
      ...pids.flatMap(pid => ["-pid", String(pid)])]);
    assert.equal(top.exitCode, 0, top.stderr.toString());
    for (const line of top.stdout.toString().split("\n")) {
      const [id, mem] = line.trim().split(/\s+/);
      const pid = Number(id);
      if (pids.includes(pid) && mem) footprints.set(pid, mem);
    }
    assert.equal(footprints.size, pids.length, "Darwin top did not report all three idle fixture PIDs");
  }
  const role = (pid: number) => {
    const rssKiB = rows.get(pid);
    assert(rssKiB, `Missing idle sample for owned PID ${pid}`);
    return { pid, rssKiB, ...(footprints.has(pid) ? { darwinTopMem: footprints.get(pid) } : {}) };
  };
  console.log(JSON.stringify({ idleMemory: { gateway: role(gatewayPid), rustOwner: role(head.ownerPid), stockOmp: role(head.pid) } }));
}

async function withNativeSettingsLock(fixture: NativeRustGateway, config: string, proof: () => Promise<void>): Promise<void> {
  const held = join(fixture.root, "native-settings-locked");
  const release = join(fixture.root, "release-native-settings-lock");
  // Use the SDK's actual platform lock in the fixture's private native environment.
  const locker = fixture.run([process.execPath, "--no-env-file", "--no-install", "-e", `
    const { acquireFileLock } = await import(${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-utils/file-lock"))});
    const lock = await acquireFileLock(${JSON.stringify(config)});
    try {
      await Bun.write(${JSON.stringify(held)}, "");
      while (!await Bun.file(${JSON.stringify(release)}).exists()) await Bun.sleep(25);
    } finally { lock.release(); }
  `]);
  try {
    await Promise.race([
      until(() => existsSync(held) || undefined, "the native settings writer lock"),
      locker.then(() => { throw new Error("Native settings lock exited before release"); }),
    ]);
    await proof();
  } finally {
    await writeFile(release, "");
    await locker;
  }
}

nativeTest("native Gateway stops only settled work and resumes the original stock OMP session", () =>
  withNativeRustGateway(async fixture => {
    const nativeConfig = join(fixture.root, "agent", "config.yml");
    const enabledSettings = JSON.parse(await readFile(nativeConfig, "utf8"));
    const globallyOff = JSON.stringify({ ...enabledSettings, memory: { backend: "off" } });
    await writeFile(nativeConfig, globallyOff);
    const first = await fixture.start();
    assert.deepEqual(Bun.YAML.parse(await readFile(nativeConfig, "utf8")), enabledSettings,
      "An owned startup repairs only the globally disabled memory setting");
    sampleIdleMemory(first.gatewayPid, first.head);
    // Omit the bot credential: a mistaken new launch cannot reach the network.
    await writeFile(nativeConfig, globallyOff);
    const reused = JSON.parse((await fixture.run([await requireGateway(), "launch", "--config", fixture.config])).stdout) as GatewayStatus;
    assert.equal(reused.gateway.pid, first.gatewayPid);
    assert.equal(reused.head.pid, first.head.pid);
    assert.equal(await readFile(nativeConfig, "utf8"), globallyOff, "A redundant launch must not write memory settings");
    await writeFile(nativeConfig, JSON.stringify(enabledSettings));
    await fixture.deliver(headInput("201"));
    assert.equal(await verifyDelivery(fixture, "201"), "HEAD:201");
    assert.deepEqual(await fixture.snapshot("settled"), first.head);
    await fixture.stop(first);

    const second = await fixture.start();
    assert.notEqual(second.head.pid, first.head.pid);
    assert.notEqual(second.head.ownerPid, first.head.ownerPid);
    assert.equal(second.head.sessionId, first.head.sessionId);
    sampleIdleMemory(second.gatewayPid, second.head);
    await fixture.deliver(headInput("207"));
    await until(() => existsSync(join(fixture.root, "entered-207")) || undefined, "the held offline model turn");
    assert.deepEqual(await fixture.snapshot("streaming"), second.head);
    const refusal = await fixture.cli("stop", 1);
    assert.match(refusal.stderr, /Host is busy\b/);
    assert.deepEqual(await fixture.snapshot("streaming"), second.head);
    const status = await fixture.cliStatus();
    assert(status, "Busy refusal must retain the original Gateway");
    assert.equal(status.gateway.pid, second.gatewayPid);
    assert.equal(status.gateway.stopping, false);
    assert.equal(status.head.pid, second.head.pid);
    await fixture.releaseBusy();
    assert.equal(await verifyDelivery(fixture, "207"), "HEAD:207");
    assert.deepEqual(await fixture.snapshot("settled"), second.head);
    await fixture.stop(second);
    assert.equal(await verifyDelivery(fixture, "201"), "HEAD:201");
    assert.deepEqual((await sendReceipts(fixture)).map(receipt => receipt.output.sourceId), ["201", "207"]);
    await verifyTranscript(fixture, [first.head, second.head], ["201", "207"]);
  }), 300_000);

nativeTest("authorized messenger /restart accepts compatible config drift and hands off once to the same stock session", () =>
  withNativeRustGateway(async fixture => {
    const first = await fixture.start();
    await fixture.deliver(headInput("201"));
    assert.equal(await verifyDelivery(fixture, "201"), "HEAD:201");
    const cold = await fixture.observeModel();
    assert.deepEqual(cold.head, first.head);

    // Change a real native launch setting after the original daemon loaded it.
    const originalConfig = await readFile(fixture.config, "utf8");
    const nextConfig = JSON.stringify({ ...JSON.parse(originalConfig), maxSubagents: 4, headIdleMs: 0 });
    assert.notEqual(nextConfig, originalConfig);
    await writeFile(fixture.config, nextConfig);
    const nativeConfig = join(fixture.root, "agent", "config.yml");
    const enabledSettings = JSON.parse(await readFile(nativeConfig, "utf8"));
    const globallyOff = JSON.stringify({ ...enabledSettings, memory: { backend: "off" } });
    await writeFile(nativeConfig, globallyOff);
    const acceptedHash = createHash("sha256").update(nextConfig).digest("hex");
    const restart = input("211", "/restart");
    await withNativeSettingsLock(fixture, nativeConfig, async () => {
      await fixture.deliver(restart);
      assert.match(await verifyDelivery(fixture, restart.id, "211:restart-ack"), /ACK, not restart completion/);
      await fixture.initialExit();
      await fixture.headExit(first.head);
      const record = ledger(fixture, db => JSON.parse(meta(db, "gateway:restart")!) as GatewayRestartRecord);
      assert.equal(record.state, "head-stopped");
      assert.equal(record.successorPid, undefined, "Handoff must not publish a launch before the settings repair");
      assert.equal(await readFile(nativeConfig, "utf8"), globallyOff,
        "Runner readiness and predecessor shutdown must not wait for or write native settings");
    });
    const handoff = await until(() => ledger(fixture, db => {
      const saved = meta(db, "gateway:restart");
      if (!saved) return;
      const record: GatewayRestartRecord = JSON.parse(saved);
      assert(!["refused", "failed", "uncertain"].includes(record.state), saved);
      if (record.state === "started") return record;
    }), "native restart runner's durable started receipt");
    assert.equal(handoff.inputId, restart.id);
    assert.equal(handoff.ackOutputId, "211:restart-ack");
    assert.equal(handoff.gatewayPid, first.gatewayPid);
    assert.equal(handoff.headPid, first.head.pid);
    assert.equal(handoff.sessionId, first.head.sessionId);
    assert.equal(handoff.sessionFile, first.head.sessionFile);
    assert(handoff.successorPid && handoff.replacementPid, "Native handoff did not record both replacement PIDs");
    const runner = ledger(fixture, db => {
      const saved = meta(db, `gateway:restart-plan:${handoff.requestId}`);
      assert(saved);
      const plan: { configHash: string; runnerPid: number; runnerReady: boolean; launchPid: number } = JSON.parse(saved);
      assert.equal(plan.configHash, acceptedHash);
      assert.equal(plan.runnerReady, true);
      assert.equal(plan.launchPid, handoff.successorPid);
      return plan.runnerPid;
    });
    assert.equal(new Set([first.gatewayPid, first.head.pid, runner, handoff.successorPid, handoff.replacementPid]).size, 5);
    assert.deepEqual(await fixture.detached(), [
      { role: "runner", pid: runner }, { role: "successor", pid: handoff.successorPid },
    ]);
    await waitForFixtureProcessExit([runner]);
    const successor = await fixture.ready(handoff.successorPid);
    assert.deepEqual(Bun.YAML.parse(await readFile(nativeConfig, "utf8")), enabledSettings,
      "The authenticated restart leaves the native profile with enabled memory");
    assert.equal(successor.head.pid, handoff.replacementPid);
    assert.notEqual(successor.head.ownerPid, first.head.ownerPid);
    assert.equal(successor.head.sessionId, first.head.sessionId);
    const resumed = await fixture.observeModel();
    assert.deepEqual(resumed.head, successor.head);
    const result = await verifyDelivery(fixture, restart.id, "211:restart-result");
    assert.match(result, /replacement HEAD is initialized and ready/,
      `Restart result: ${result}\nPublic get_state cold/resumed: ${JSON.stringify({ cold, resumed })}`);

    // Redeliver the exact authorized wire event after the replacement is ready.
    await fixture.deliver(restart);
    await fixture.deliver(headInput("212"));
    assert.equal(await verifyDelivery(fixture, "212"), "HEAD:212");
    assert.deepEqual(await fixture.snapshot("settled"), successor.head);
    await fixture.stop(successor);
    assert.deepEqual((await sendReceipts(fixture)).map(receipt => receipt.output.sourceId), ["201", "211", "211", "212"]);
    assert.deepEqual((await fixture.detached()).map(process => process.pid), [runner, handoff.successorPid]);
    assert.equal(ledger(fixture, db => db.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM metadata WHERE key LIKE 'gateway:restart:%'").get()?.count), 1);
    await verifyTranscript(fixture, [first.head, successor.head], ["201", "212"]);
  }), 300_000);

nativeTest("native Gateway refuses an unsupported restart memory profile before shutting down HEAD", () =>
  withNativeRustGateway(async fixture => {
    const first = await fixture.start();
    const nativeConfig = join(fixture.root, "agent", "config.yml");
    const blocked = JSON.stringify({ ...JSON.parse(await readFile(nativeConfig, "utf8")), memory: { backend: "unsupported-fixture" } });
    await writeFile(nativeConfig, blocked);
    const restart = input("211", "/restart");
    await fixture.deliver(restart);
    assert.match(await verifyDelivery(fixture, restart.id, "211:restart-ack"), /ACK, not restart completion/);
    const record = await until(() => ledger(fixture, db => {
      const saved = meta(db, "gateway:restart");
      if (!saved) return;
      const result: GatewayRestartRecord = JSON.parse(saved);
      if (result.state === "refused") return result;
    }), "pre-shutdown refusal of unsupported native memory");
    assert.equal(record.headPid, first.head.pid);
    assert.equal(record.successorPid, undefined);
    assert.match(record.reason ?? "", /no process was stopped/);
    assert.equal(await readFile(nativeConfig, "utf8"), blocked);
    const processes = await fixture.detached();
    assert.deepEqual(processes.map(process => process.role), ["runner"]);
    await waitForFixtureProcessExit(processes.map(process => process.pid));
    assert.deepEqual(await fixture.snapshot("settled"), first.head);
    await fixture.stop(first);
    await verifyTranscript(fixture, [first.head], []);
  }), 300_000);
