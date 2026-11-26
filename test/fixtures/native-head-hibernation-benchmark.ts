/** Run from the repository root with the native binaries and stock OMP.
 *  cargo build --release --locked --manifest-path gateway/Cargo.toml --example gateway-lifecycle-fixture
 *  OMP_SUPERAGENT_NATIVE_TEST=1 OMP_TEST_COMMAND='["/path/to/stock/omp"]' \
 *    bun --no-env-file test/fixtures/native-head-hibernation-benchmark.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { Database } from "bun:sqlite";
import { fixtureHostLaunches } from "./host-fixture-processes";
import { assertRestoredSelection, assertSameSession, configureIdleHead, headIdleMs, waitForDormantHead } from "./native-head-hibernation";
import type { Head } from "./native-rust-gateway";
import { headInput, ledger, verifyDelivery, verifyTranscript, withNativeRustGateway, type NativeRustGateway } from "./native-rust-gateway-assertions";

const pairs = 12;
const gatewayProfile = "release";
const roles = ["gateway", "ompHead", "rustPipeOwner"] as const;
type MemorySample = { readonly pid: number; readonly rssKiB: number; readonly darwinPhysicalFootprintKiB?: number };
type MemoryPhase = Readonly<Record<(typeof roles)[number], MemorySample | null>>;

function sampleProcessMemory() {
  if (process.platform === "darwin") {
    const lib = dlopen("/usr/lib/libproc.dylib", {
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    return {
      source: "Darwin proc_pid_rusage/RUSAGE_INFO_V0: ri_resident_size and ri_phys_footprint, bytes / 1024",
      sample(pid: number): MemorySample {
        // sys/resource.h rusage_info_v0: 16-byte UUID followed by ten u64s.
        const usage = new BigUint64Array(12);
        assert.equal(lib.symbols.proc_pid_rusage(pid, 0, ptr(usage)), 0, `proc_pid_rusage(${pid}) failed`);
        return { pid, rssKiB: Number(usage[8]) / 1024, darwinPhysicalFootprintKiB: Number(usage[9]) / 1024 };
      },
      close: () => lib.close(),
    };
  }
  assert.equal(process.platform, "linux", "The native Gateway benchmark requires Darwin or Linux");
  return {
    source: "Linux ps RSS in KiB; no physical-footprint counter",
    sample(pid: number): MemorySample {
      const ps = Bun.spawnSync(["/bin/ps", "-o", "pid=", "-o", "rss=", "-p", String(pid)]);
      assert.equal(ps.exitCode, 0, ps.stderr.toString());
      const [observed, rssKiB] = ps.stdout.toString().trim().split(/\s+/).map(Number);
      assert.equal(observed, pid);
      assert(rssKiB > 0, `No RSS reading for owned PID ${pid}`);
      return { pid, rssKiB };
    },
    close() { /* ps has no retained handle */ },
  };
}

function installDeliveryClock(fixture: NativeRustGateway): void {
  const db = new Database(join(fixture.root, "coordination.sqlite"), { strict: true });
  try {
    db.exec(`
      PRAGMA busy_timeout=5000;
      BEGIN IMMEDIATE;
      CREATE TABLE hibernation_bench_sent (output_id TEXT PRIMARY KEY, sent_ms INTEGER NOT NULL);
      CREATE TRIGGER hibernation_bench_clock AFTER UPDATE OF state ON outputs
      WHEN OLD.state <> 'sent' AND NEW.state = 'sent' AND NEW.status=0 AND NEW.remote_id IS NOT NULL
      BEGIN
        INSERT INTO hibernation_bench_sent VALUES(NEW.id, CAST(strftime('%s','now') AS INTEGER) * 1000
          + CAST(substr(strftime('%f','now'),4,3) AS INTEGER));
      END;
      COMMIT;
    `);
  } finally { db.close(); }
}

async function measuredTurn(fixture: NativeRustGateway, id: string) {
  const source = headInput(id);
  await fixture.deliver(source);
  assert.equal(await verifyDelivery(fixture, source), `HEAD:${id}`);
  const timestamps = ledger(fixture, db => db.query<{
    readonly ingressEpochMs: number;
    readonly durableFinalEpochMs: number;
  }, [string, string]>(`
    SELECT e.received_at AS ingressEpochMs, s.sent_ms AS durableFinalEpochMs
    FROM gateway_events e
    JOIN outputs o ON o.source_id = ? AND o.status = 0 AND o.state = 'sent'
    JOIN hibernation_bench_sent s ON s.output_id = o.id
    WHERE e.identity = ?
    ORDER BY s.sent_ms, o.sequence LIMIT 1
  `).get(id, `message:${id}`));
  assert(timestamps, `No persisted final transition for ${id}`);
  const latencyMs = timestamps.durableFinalEpochMs - timestamps.ingressEpochMs;
  assert(latencyMs >= 0, "Clock moved backwards during the measured turn");
  return { id, ...timestamps, latencyMs };
}

function range(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const n = sorted.length;
  if (!n) return null;
  return { n, min: sorted[0], median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2, max: sorted[n - 1] };
}

function memoryRanges(phases: readonly MemoryPhase[]) {
  return Object.fromEntries(roles.map(role => {
    const present = phases.flatMap(phase => phase[role] ?? []);
    return [role, {
      absent: phases.length - present.length,
      rssKiB: range(present.map(row => row.rssKiB)),
      darwinPhysicalFootprintKiB: range(present.flatMap(row => row.darwinPhysicalFootprintKiB ?? [])),
    }];
  }));
}

if (import.meta.main) {
  assert.equal(process.env.OMP_SUPERAGENT_NATIVE_TEST, "1", "Opt in to the isolated native Gateway benchmark");
  const memory = sampleProcessMemory();
  try {
    await withNativeRustGateway(async fixture => {
      await configureIdleHead(fixture);
      let host = await fixture.start();
      const gatewayPid = host.gatewayPid;
      const memoryPhase = (head?: Head): MemoryPhase => ({
        gateway: memory.sample(gatewayPid),
        ompHead: head ? memory.sample(head.pid) : null,
        rustPipeOwner: head ? memory.sample(head.ownerPid) : null,
      });
      const priming = headInput("11000");
      await fixture.deliver(priming);
      assert.equal(await verifyDelivery(fixture, priming), "HEAD:11000");
      const selection = await fixture.observeModel();
      assert.deepEqual(selection.head, host.head);
      installDeliveryClock(fixture);

      const witnesses = [host.head];
      const requests = [priming.id];
      const trials = [];
      const plans = new Set<string>();
      for (let index = 0; index < pairs; index++) {
        const status = await fixture.status();
        assert.equal(status.gateway.pid, gatewayPid);
        assert.equal(status.head.pid, host.head.pid);
        assert.equal(status.head.ready, true);
        const warm = await measuredTurn(fixture, String(11_001 + index * 2));
        assert.deepEqual(await fixture.snapshot("settled"), host.head, "A warm sample must use the current resident HEAD");
        const resident = memoryPhase(host.head);
        const sleepPlan = await waitForDormantHead(fixture, host);
        assert(!plans.has(sleepPlan), "Each measured wake must follow a new confirmed sleep");
        plans.add(sleepPlan);
        const sleeping = memoryPhase(); // Both old PIDs are gone, not live processes with zero RSS.
        const wake = await measuredTurn(fixture, String(11_002 + index * 2));
        const resumed = await fixture.ready(gatewayPid);
        assertSameSession(resumed.head, host.head);
        const actual = await fixture.observeModel();
        assert.deepEqual(actual.head, resumed.head);
        assertRestoredSelection(actual, selection);
        const afterWake = memoryPhase(resumed.head);
        trials.push({ trial: index + 1, sleepPlan, exitedHeadPid: host.head.pid, exitedOwnerPid: host.head.ownerPid,
          warm, wake, resident, sleeping, afterWake });
        witnesses.push(resumed.head);
        requests.push(warm.id, wake.id);
        host = resumed;
      }

      await waitForDormantHead(fixture, host);
      await fixture.stop(host);
      assert.equal((await fixtureHostLaunches(fixture.root)).length, pairs + 1);
      await verifyTranscript(fixture, witnesses, requests);
      console.log(JSON.stringify({
        benchmark: "native HEAD hibernation",
        gatewayProfile,
        os: process.platform, arch: process.arch, bun: Bun.version, headIdleMs,
        samplePairs: trials.length, primingTurnsExcluded: 1, nativeNetworkAttempts: 0,
        latencyEndpoint: "Gateway admission to final output marked sent after the offline adapter receipt; epoch timestamps recorded in the durable writes, not at poll time",
        warmLatencyMs: range(trials.map(trial => trial.warm.latencyMs)),
        wakeLatencyMs: range(trials.map(trial => trial.wake.latencyMs)),
        pairedWakeMinusWarmMs: range(trials.map(trial => trial.wake.latencyMs - trial.warm.latencyMs)),
        memorySource: memory.source,
        memoryRanges: {
          resident: memoryRanges(trials.map(trial => trial.resident)),
          sleeping: memoryRanges(trials.map(trial => trial.sleeping)),
          afterWake: memoryRanges(trials.map(trial => trial.afterWake)),
        },
        trials,
      }));
    }, gatewayProfile);
  } finally { memory.close(); }
}
