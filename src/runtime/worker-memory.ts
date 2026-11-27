import { createHash } from "node:crypto";
import { join } from "node:path";
import { Type } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";
import type { Lane, StorePort } from "../contracts";
import type { prepareWorkerMemoryImport } from "../omp/worker-memory-import";
import { parseWorkerMemoryPage } from "../worker/worker-memory-page";
import { workerMemoryCheckoutStamp, workerMemoryRepositoryMatches } from "../worker/worker-repository";
import type { WorkerProbe, WorkerRegistration } from "../worker/worker-wire";
import { successful, type RuntimeHost } from "./native-frames";

type Destination = NonNullable<ReturnType<typeof prepareWorkerMemoryImport>>;
export type MemoryDestination = (headId: string, headFile: string, cwd: string) => Destination | undefined;
const digest = (parts: readonly unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const statusKey = (id: string) => `worker-memory:status:${id}`;
const changeStamp = /^[a-f0-9]{64}$/;
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const observation = { generation: count, at: count };
const exact = { additionalProperties: false };
const pendingIndex = new WeakMap<StorePort, Map<string, string>>();
const report = Type.Union([
  Type.Object({ ...observation, status: Type.Literal("unavailable") }, exact),
  Type.Object({ ...observation, status: Type.Literal("unchanged") }, exact),
  Type.Object({ ...observation, status: Type.Literal("checked"), cursor: count, records: count,
    inserted: count, skipped: count, rejected: count, lexical: count, indexed: count, disabled: count, pending: count, deferred: count }, exact),
]);

interface ScanCursor { after: number; start?: string; unchanged?: string }
function scanCursor(saved: string | null): ScanCursor {
  if (!saved) return { after: 0 };
  const cursor: ScanCursor = JSON.parse(saved);
  if (!Number.isSafeInteger(cursor.after) || cursor.after < 0
    || cursor.start !== undefined && !changeStamp.test(cursor.start)
    || cursor.unchanged !== undefined && (!changeStamp.test(cursor.unchanged) || cursor.after !== 0))
    throw new Error("Invalid memory scan cursor");
  return cursor;
}

export function workerMemoryStatus(store: StorePort, laneId: string) {
  const raw = store.getMeta(statusKey(laneId));
  if (!raw) return null;
  if (raw.length <= 512) {
    try {
      const status: unknown = JSON.parse(raw);
      if (Value.Check(report, status)) {
        if (status.status === "checked" && status.pending && pendingIndex.get(store)?.get(laneId) !== raw)
          return { ...status, pending: 0, deferred: status.deferred + status.pending };
        return status;
      }
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return { status: "unavailable" } as const;
}

/** Use the same checkout proof before redirecting a fresh worker bank and before importing it. */
export async function verifyMemoryCheckout(lane: Pick<Lane, "cwd" | "repoRoot" | "remote">) {
  try {
    if (!lane.remote || !lane.repoRoot) return;
    const checkout = { ...lane.remote, repoRoot: lane.repoRoot, gitDir: join(lane.repoRoot, ".git") };
    const stamp = workerMemoryCheckoutStamp(lane.cwd, checkout);
    if (!stamp || !await workerMemoryRepositoryMatches(lane.cwd, checkout)) return;
    return () => workerMemoryCheckoutStamp(lane.cwd, checkout) === stamp;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // Optional private storage must never prevent a normal remote launch.
    return undefined;
  }
}

/** A read of the already attached owner, never an open, resume, model turn or SSH path request. */
export async function pullWorkerMemory(store: StorePort, lane: Pick<Lane,
  "id" | "generation" | "cwd" | "repoRoot" | "remote" | "pid" | "sessionId" | "sessionFile">, source: {
  connection: Pick<RuntimeHost, "request">;
  registration: WorkerRegistration;
  lookup(): Promise<WorkerRegistration>;
  probe(reg: WorkerRegistration): Promise<WorkerProbe>;
  destination(): Destination | undefined;
  current(): boolean;
  confirmIdleHead(): Promise<boolean>;
  ownsStatus(): boolean;
  canIndex(): boolean;
}) {
  const remote = lane.remote;
  if (!remote || !lane.sessionId || !lane.repoRoot || join(lane.repoRoot, remote.subdir) !== lane.cwd) return;
  try {
    const dest = source.destination();
    if (!dest || !source.current()) return;
    const validEnrollment = (reg: WorkerRegistration) => reg.destination === source.registration.destination
      && reg.identityFile === source.registration.identityFile && reg.description.workerId === remote.workerId
      && reg.description.stateDir === remote.stateDir && reg.description.repos.some(repo => repo.id === remote.repoId
        && source.registration.description.repos.some(saved => saved.id === repo.id && saved.cwd === repo.cwd));
    const reg = await source.lookup();
    if (!validEnrollment(reg) || !source.current()) return;
    const [checkoutUnchanged, owner] = await Promise.all([verifyMemoryCheckout(lane), source.probe(reg)]);
    if (!checkoutUnchanged?.() || !source.current()
      || owner.memorySyncVersion !== 1 || owner.uncertain || !owner.socket || !owner.pidAlive || !owner.ownerAlive
      || !owner.sessionFile || owner.pid !== lane.pid || owner.sessionId !== lane.sessionId) return;
    const origin = digest([remote.workerId, remote.stateDir, remote.repoId, remote.revision, remote.subdir,
      lane.id, lane.cwd, lane.sessionId, lane.sessionFile]);
    const key = `worker-memory:cursor:${digest([dest.namespace, origin])}`;
    const { after, start, unchanged } = scanCursor(store.getMeta(key));
    const reply = await source.connection.request({ type: "get_worker_memory", after, ...(unchanged && { unchanged }) });
    if (!source.current()) return;
    const page = parseWorkerMemoryPage(successful(reply, "get_worker_memory"), after);
    if (!validEnrollment(await source.lookup()) || !source.current()
      || !await source.confirmIdleHead()) return;
    const currentDest = source.destination();
    if (!currentDest || currentDest.namespace !== dest.namespace || !source.current() || !checkoutUnchanged()) return;
    if (unchanged === page.stamp && !after && !page.next && !page.records.length) {
      // Keep the last actual index readback; an empty stamp response is not another vector check.
      const previous = workerMemoryStatus(store, lane.id);
      if (previous?.status !== "checked" || previous.generation !== lane.generation)
        store.tryWorkerMemoryMeta(statusKey(lane.id), JSON.stringify({ generation: lane.generation, at: Date.now(), status: "unchanged" }));
      return;
    }
    // Commit through the original live SDK capability. A same-path replacement
    // or change in its native settings is not the policy that authorized the read.
    const receiptKey = (id: string) => `worker-memory:imported:${digest([dest.receiptNamespace, id])}`;
    const result = dest.importPage(page.records, origin, {
      seen: id => store.getMeta(receiptKey(id)) === "1",
      mark: ids => {
        if (!store.tryWorkerMemoryMeta(ids.map(receiptKey), "1")) throw new Error("Memory receipts not reserved");
      },
    }, () => source.canIndex() && checkoutUnchanged());
    if (result === undefined) return;
    const first = after === 0 ? page.stamp : start;
    const cursor: ScanCursor = { after: page.next };
    if (first === page.stamp) {
      if (page.next === 0) cursor.unchanged = first;
      else cursor.start = first;
    }
    if (!store.tryWorkerMemoryMeta(key, JSON.stringify(cursor))) return;
    const { confirmation, ...counts } = result;
    const status = { generation: lane.generation, at: Date.now(), status: "checked",
      cursor: page.next, records: page.records.length, ...counts };
    const receipt = JSON.stringify(status);
    store.tryWorkerMemoryMeta(statusKey(lane.id), receipt);
    if (!confirmation) return;
    const tasks = pendingIndex.get(store) ?? new Map<string, string>();
    pendingIndex.set(store, tasks);
    tasks.set(lane.id, receipt);
    // Native indexing may finish after eviction. A later page, a different native
    // generation, or stopped HEAD owns its own status; don't hold release to update it.
    void confirmation.then(observed => {
      if (observed && source.ownsStatus() && store.getMeta(statusKey(lane.id)) === receipt)
        store.tryWorkerMemoryMeta(statusKey(lane.id), JSON.stringify({ ...status, ...observed }));
    }).catch(() => { /* A lost readback is not confirmation of a vector. */ }).finally(() => {
      if (tasks.get(lane.id) === receipt) tasks.delete(lane.id);
    });
  } catch {
    // Neither worker error strings nor SDK diagnostics belong in logs, the ledger or a model turn.
    if (source.current()) store.tryWorkerMemoryMeta(statusKey(lane.id), JSON.stringify({
      generation: lane.generation, at: Date.now(), status: "unavailable",
    }));
  }
}
