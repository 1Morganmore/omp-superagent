import { SQLiteError, type Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { MAIN_AGENT_ID, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getMemoriesDir } from "@oh-my-pi/pi-utils/dirs";
import { nativeMemoryProjectCwd } from "./native-sessions";
import type * as StockMemorySdk from "./worker-memory-sdk";
import {
  type WorkerMemoryRecord, WORKER_MEMORY_PAGE_BYTES, WORKER_MEMORY_ROWS, safeWorkerMemoryText, workerMemoryId,
} from "../worker/worker-memory-page";

type NativeState = NonNullable<ReturnType<AgentSession["getMnemopiSessionState"]>>;
type NativeMemory = NativeState["memory"];
type Sdk = typeof StockMemorySdk;
export type WorkerMemoryImportResult = WorkerMemoryIndexStatus & {
  readonly inserted: number;
  readonly skipped: number;
  readonly rejected: number;
  readonly confirmation?: Promise<WorkerMemoryIndexStatus | undefined>;
};
type WorkerMemoryIndexStatus = {
  readonly lexical: number;
  readonly indexed: number;
  readonly disabled: number;
  readonly pending: number;
  readonly deferred: number;
};
export type WorkerMemoryImport = {
  readonly namespace: string;
  readonly receiptNamespace: string;
  importPage(
    records: readonly WorkerMemoryRecord[], origin: string, receipts?: WorkerMemoryReceipts, canIndex?: () => boolean,
  ): WorkerMemoryImportResult | undefined;
};
export type WorkerMemoryReceipts = {
  seen(digest: string): boolean;
  mark(digests: readonly string[]): void;
};

const source = "superagent-worker-fact";
const bankFiles = new WeakMap<NativeMemory, { readonly namespace: string; readonly sidecars: string }>();
const durablePolicies = new WeakMap<AgentSession["settings"], {
  revision: number; unsafe: boolean; disabled: boolean; offline: boolean;
}>();
const pendingVectors = new WeakMap<NativeMemory, Map<string, Promise<void>>>();
const digest = (parts: readonly string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

function usesLocalModel(sdk: Sdk, model: unknown): boolean {
  return typeof model === "string" && typeof sdk.fastembedModelName(model.trim()) === "string";
}

function durablePolicy(settings: AgentSession["settings"], sdk: Sdk) {
  const revision = settings.revision;
  const cached = durablePolicies.get(settings);
  if (cached?.revision === revision) return cached;
  const layers = settings.mirrorState();
  let disabled = false;
  let offline = false;
  let unsafe = false;
  for (const layer of [layers.global, layers.project, layers.configOverlay]) {
    const models = layer.models;
    if (models !== undefined && (models === null || typeof models !== "object" || Array.isArray(models))) offline = false;
    else if (models && "offline" in models) {
      if (models.offline !== true) offline = false;
      else if (layer === layers.global) offline = true;
    }
    const group = layer.mnemopi;
    if (group === undefined) continue;
    if (group === null || typeof group !== "object" || Array.isArray(group)) {
      unsafe = true;
      disabled = false;
      continue;
    }
    if ("noEmbeddings" in group) {
      if (group.noEmbeddings !== true) disabled = false;
      // Only the underlying profile can prove disabled if a project or
      // invocation overlay is omitted the next time native OMP opens the bank.
      else if (layer === layers.global) disabled = true;
    }
    if (("embeddingApiUrl" in group && group.embeddingApiUrl) ||
      ("embeddingModel" in group && group.embeddingModel && !usesLocalModel(sdk, group.embeddingModel))) unsafe = true;
  }
  const result = { revision, disabled, offline, unsafe };
  durablePolicies.set(settings, result);
  return result;
}

function bankIdentity(path: string) {
  if (realpathSync(path) !== path) return;
  const database = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!database?.isFile() || database.nlink !== 1n) return;
  const sidecars = [];
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = lstatSync(path + suffix, { bigint: true, throwIfNoEntry: false });
    if (sidecar && (!sidecar.isFile() || sidecar.nlink !== 1n)) return;
    sidecars.push(sidecar ? `${sidecar.dev}:${sidecar.ino}` : "");
  }
  return { file: `${database.dev}:${database.ino}`, sidecars: sidecars.join(",") };
}

function readNativeSetting(settings: AgentSession["settings"], key: string, includeDefault = false): unknown {
  const setting = lookup(key);
  if (!setting) throw new WorkerMemoryImportError("Native worker memory settings unavailable");
  return settings.rawValue(setting) ?? (includeDefault ? setting.default : undefined);
}

function liveDestination(session: AgentSession, cwd: string, sdk: Sdk) {
  // The caller verifies stock class/registry identity via the running Host's injected pi.pi.
  const settingsCwd = session.settings.getCwd();
  if (session.getAgentId() !== MAIN_AGENT_ID || session.isDisposed !== false || !session.memoryEnabled
    || !session.sessionFile || session.hindsightActive !== false || session.sessionManager.getCwd() !== cwd
    || !isAbsolute(cwd) || realpathSync(cwd) !== cwd
    || (settingsCwd !== cwd && settingsCwd !== nativeMemoryProjectCwd(cwd))) return;
  const workspace = lstatSync(cwd, { bigint: true });
  if (!workspace.isDirectory()) return;

  const { settings } = session;
  if (readNativeSetting(settings, "memory.backend") !== "mnemopi"
    || readNativeSetting(settings, "mnemopi.scoping", true) !== "per-project") return;
  const state = session.getMnemopiSessionState();
  if (!state || state.aliasOf || state.session !== session || state.sessionId !== session.sessionId
    || state.config.scoping !== "per-project") return;
  const configuredBank = readNativeSetting(settings, "mnemopi.bank");
  const scope = sdk.computeMnemopiBankScope(typeof configuredBank === "string" ? configuredBank : undefined, settingsCwd, "per-project");
  const { bank, memory } = state.getScopedRetainTarget();
  const beam = memory.beam;
  const recall = state.getScopedRecallTargets();
  if (bank !== scope.retainBank || state.config.retainBank !== bank || state.config.globalBank !== scope.globalBank
    || bank === scope.globalBank || recall.length !== 1 || recall[0]?.memory !== memory
    || memory !== state.memory || memory.bank !== bank || memory.sessionId !== bank || memory.channelId !== bank
    || beam.sessionId !== bank || beam.channelId !== bank || memory.db !== beam.db
    || typeof beam.importFromDict !== "function" || !(beam.pendingExtractions instanceof Set)) return;

  const agentDir = settings.getAgentDir();
  if (!isAbsolute(agentDir) || realpathSync(agentDir) !== agentDir) return;
  const profile = lstatSync(agentDir, { bigint: true });
  if (!profile.isDirectory()) return;
  const base = state.config.dbPath;
  const configuredPath = readNativeSetting(settings, "mnemopi.dbPath");
  if (resolve(base) !== base || (typeof configuredPath === "string" && configuredPath.trim()
    ? base !== configuredPath.trim() || !base.startsWith(agentDir + sep)
    : base !== join(getMemoriesDir(agentDir), "mnemopi", "mnemopi.db"))) return;
  const path = join(dirname(base), "banks", bank, "mnemopi.db");
  if (memory.dbPath !== path || beam.dbPath !== path || beam.db.filename !== path) return;
  const identity = bankIdentity(path);
  if (!identity) return;
  const receiptNamespace = digest([agentDir, cwd, path, bank]);
  const namespace = digest([receiptNamespace, `${profile.dev}:${profile.ino}`, `${workspace.dev}:${workspace.ino}`, identity.file]);
  const prior = bankFiles.get(memory);
  if (prior && (prior.namespace !== namespace || prior.sidecars !== identity.sidecars)) return;
  bankFiles.set(memory, { namespace, sidecars: identity.sidecars });

  const options = memory.runtimeOptions?.embeddings;
  const disabled = readNativeSetting(settings, "mnemopi.noEmbeddings", true);
  const embeddingModel = options?.model;
  if (!options || typeof embeddingModel !== "string" || !embeddingModel.trim()
    || options.apiUrl !== readNativeSetting(settings, "mnemopi.embeddingApiUrl")
    || options.disabled !== disabled || typeof disabled !== "boolean") return;
  // Stock API embedding follows redirects without reauthorizing their targets.
  // An eligible row with no vector could also be submitted by native startup
  // reconciliation, so don't persist worker facts under an unverified API route.
  const startupModel = readNativeSetting(settings, "mnemopi.embeddingModel");
  const ambientModel = process.env.MNEMOPI_EMBEDDING_MODEL;
  const durable = durablePolicy(settings, sdk);
  const mayUseApi = durable.unsafe || !usesLocalModel(sdk, embeddingModel) || (startupModel && !usesLocalModel(sdk, startupModel))
    || (ambientModel && !usesLocalModel(sdk, ambientModel)) || options.apiUrl
    || process.env.MNEMOPI_EMBEDDING_API_URL || process.env.OPENROUTER_BASE_URL
    || process.env.MNEMOPI_EMBEDDINGS_VIA_API;
  if (settings.overlayParent() || (mayUseApi && (!disabled || !durable.disabled))) return;
  // On reopen, stock reconciliation can route missing vectors through its
  // process-wide override before local resolution. A local model name or a
  // temporary offline setting is not a durable prohibition on that route.
  if (!(disabled && durable.disabled)
    && !(durable.offline && readNativeSetting(settings, "models.offline", true) === true)) return;
  if (!disabled && !options.provider && options.allowRemote?.("") !== false) return;
  return {
    namespace, receiptNamespace, state, memory, bank, options, embeddingModel, disabled, sdk, sessionId: session.sessionId,
    sessionFile: session.sessionFile, revision: settings.revision,
  };
}

function destinationOrUnavailable(session: AgentSession, cwd: string, sdk: Sdk) {
  try {
    return liveDestination(session, cwd, sdk);
  } catch (error) {
    // A missing file, closed handle, or unsupported installed SDK is not a destination.
    if (!(error instanceof Error)) throw error;
    return undefined;
  }
}

type Destination = NonNullable<ReturnType<typeof liveDestination>>;

function mayScheduleEmbedding({ options, disabled }: Destination): boolean {
  return !disabled && !!options.provider && options.allowRemote?.("") === true;
}

async function stockDocumentEmbedding(destination: Destination, texts: readonly string[], current: () => boolean) {
  const { memory, options, sdk } = destination;
  const scope = memory.runtimeOptions;
  if (!scope || scope.embeddings !== options || !options.provider || !current() || !mayScheduleEmbedding(destination)) return;
  // The bridge may use the exact authorized stock in-process provider, never
  // the SDK's process-wide override, default resolver or model initializer.
  const scoped = { ...scope, embeddings: { ...options, provider: options.provider } };
  return sdk.withMnemopiRuntimeOptions(scoped, () =>
    sdk.getMnemopiRuntimeOptions() === scoped ? sdk.embed(texts, "document") : null);
}

/** Do not block HEAD for the live connection's usual 5s busy timeout. */
function withoutLockWait<T>(db: Database, action: () => T): T | undefined {
  const original = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
  if (!original) throw new WorkerMemoryImportError("Cannot read native SQLite lock policy");
  db.exec("PRAGMA busy_timeout=0");
  try {
    return action();
  } catch (error) {
    if (error instanceof SQLiteError && ((error.errno & 255) === 5 || (error.errno & 255) === 6)) return;
    throw error;
  } finally {
    db.exec(`PRAGMA busy_timeout=${original.timeout}`);
  }
}

function indexFresh(destination: Destination, page: {
  readonly fresh: readonly ImportRow[];
  current(): boolean;
  needsVector(row: ImportRow): boolean;
}): void {
  const { memory, embeddingModel, options, sdk } = destination;
  const { beam, db } = memory;
  if (page.fresh.length === 0 || beam.pendingExtractions.size > 64 || !mayScheduleEmbedding(destination)) return;
  const pending = pendingVectors.get(memory) ?? new Map<string, Promise<void>>();
  pendingVectors.set(memory, pending);
  const provider = options.provider;
  const authorized = () => options.provider === provider && mayScheduleEmbedding(destination) && page.current();
  const task = (async () => {
    if (!authorized()) return;
    const matrix = await stockDocumentEmbedding(destination, page.fresh.map(row => row.content), authorized);
    if (matrix?.length !== page.fresh.length || !authorized()) return;
    const staged = page.fresh.flatMap((row, index) => {
      const vector = matrix[index];
      return vector?.length && vector.every(Number.isFinite) && vector.some(value => value !== 0)
        ? [{ memoryId: row.id, content: row.content, json: JSON.stringify(Array.from(vector)), row }] : [];
    });
    if (staged.length === 0 || db.inTransaction) return;
    const committed = withoutLockWait(db, db.transaction(() => {
      if (!authorized()) return 0;
      return sdk.insertLiveEmbeddings(db, staged.filter(({ row }) => page.needsVector(row)), embeddingModel);
    }).immediate);
    if (committed) beam.caches.queryCache?.invalidate();
  })();
  for (const row of page.fresh) pending.set(row.id, task);
  beam.pendingExtractions.add(task);
  const settle = () => {
    for (const row of page.fresh) if (pending.get(row.id) === task) pending.delete(row.id);
    beam.pendingExtractions.delete(task);
  };
  void task.then(settle, settle);
}

function canWriteNow(session: AgentSession): boolean {
  // Admission can inspect the bank during lane_start, but only an idle live
  // session outside native read-only modes may authorize an actual write.
  return session.isDisposed === false && session.isSessionTransitioning === false
    && session.isRunActive === false && session.isBusyForSnapshot === false
    && session.hasAdmittedSubmission === false && session.hasPostPromptWork === false
    && session.queuedMessageCount === 0 && session.yieldQueue?.has() === false
    && typeof session.getPlanModeState === "function" && !session.getPlanModeState()?.enabled
    && typeof session.getPrewalkState === "function" && session.getPrewalkState() === undefined;
}

function importRows(records: readonly WorkerMemoryRecord[], scope: {
  readonly origin: string;
  readonly cwd: string;
  readonly bank: string;
  readonly receiptNamespace: string;
}) {
  const { origin, cwd, bank, receiptNamespace } = scope;
  return records.flatMap(record => {
    const content = record.content.trim();
    if (!safeWorkerMemoryText(record.content)
      || /<|^\s*(?:\/\w|(?:[#>*\s\[]*)(?:system|developer|assistant|user|tool|command)(?:\s*:|\s*\]))/iu.test(content)
      || /^\{\s*"(?:role|command|tool_call)"\s*:/iu.test(content)
      || !workerMemoryId.test(record.id)) return [];
    return [{
      id: digest([source, receiptNamespace, origin, content]),
      content,
      source,
      session_id: bank,
      channel_id: bank,
      scope: "bank",
      trust_tier: "IMPORTED",
      veracity: "imported",
      memory_type: "fact",
      metadata_json: JSON.stringify({ cwd, origin, row: record.id }),
    }];
  });
}

type ImportRow = ReturnType<typeof importRows>[number];

export function prepareWorkerMemoryImport(session: AgentSession, cwd: string, sdk: Sdk): WorkerMemoryImport | undefined {
  const destination = destinationOrUnavailable(session, cwd, sdk);
  if (!destination) return;
  const currentDestination = () => {
    const current = destinationOrUnavailable(session, cwd, sdk);
    if (current && current.state === destination.state && current.namespace === destination.namespace
      && current.options === destination.options
      && current.sessionId === destination.sessionId && current.sessionFile === destination.sessionFile
      && current.revision === destination.revision && current.embeddingModel === destination.embeddingModel) return current;
  };
  return {
    namespace: destination.namespace,
    receiptNamespace: destination.receiptNamespace,
    importPage(records, origin, receipts, canIndex) {
      if (!/^[0-9a-f]{64}$/u.test(origin) || records.length > WORKER_MEMORY_ROWS
        || Buffer.byteLength(JSON.stringify(records)) > WORKER_MEMORY_PAGE_BYTES) return;
      const current = currentDestination();
      if (!current || !canWriteNow(session)) return;

      const { bank, memory, embeddingModel, disabled } = current;
      const rows = importRows(records, { origin, cwd, bank, receiptNamespace: destination.receiptNamespace });
      const byId = new Map<string, ImportRow>();
      for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
      const unique = [...byId.values()];
      const { db, beam } = memory;
      if (db.inTransaction) return;
      return withoutLockWait(db, () => {
        const provenance = "source = ? AND session_id = ? AND scope = 'bank' AND CASE WHEN json_valid(metadata_json)"
          + " THEN json_extract(metadata_json, '$.origin') = ? AND json_extract(metadata_json, '$.cwd') = ? END";
        const existing = db.query<{ owned: number }, [string, string, string, string, string]>(
          `SELECT CASE WHEN ${provenance} THEN 1 ELSE 0 END AS owned FROM working_memory WHERE id = ?`,
        );
        const stored = db.query<{ found: number }, [string, string, string, string, string, string]>(
          `SELECT 1 AS found FROM working_memory WHERE id = ? AND content = ? AND ${provenance}`
          + " AND superseded_by IS NULL AND valid_until IS NULL AND embed_text IS NULL",
        );
        const fresh = unique.length === 0 ? [] : db.transaction(() => {
          const inserted: ImportRow[] = [];
          const unrecorded: string[] = [];
          for (const row of unique) {
            if (receipts?.seen(row.id)) continue;
            const existingRow = existing.get(source, bank, origin, cwd, row.id);
            if (!existingRow) inserted.push(row);
            if (receipts && (!existingRow || existingRow.owned === 1)) unrecorded.push(row.id);
          }
          if (inserted.length > 0) {
            const now = new Date().toISOString();
            const result = beam.importFromDict({ working_memory: inserted.map(row => ({
              ...row, timestamp: now, created_at: now,
            })) }, false).working_memory;
            if (result.inserted !== inserted.length || result.overwritten !== 0 || result.skipped !== 0)
              throw new WorkerMemoryImportError("Native worker memory insert did not establish all new rows");
          }
          // Two stores cannot share this commit. Fence replay before committing
          // the bank: uncertainty may leave a fact held, never revived after forget.
          if (unrecorded.length) receipts?.mark(unrecorded);
          return inserted;
        }).immediate();
        const lexicalMatch = db.query<{ found: number }, [string, string]>(
          // A dense bank may leave a result unobserved; never scan it just to confirm status.
          "SELECT 1 AS found FROM (SELECT id FROM fts_working WHERE fts_working MATCH ? LIMIT 64)"
          + " WHERE id = ? LIMIT 1",
        );
        const vector = db.query<{ found: number }, [string, string]>(
          "SELECT 1 AS found FROM memory_embeddings WHERE memory_id = ? AND model = ?"
          + " AND json_valid(embedding_json) AND json_array_length(embedding_json) > 0",
        );
        const isLive = (row: ImportRow) => stored.get(row.id, row.content, source, bank, origin, cwd) !== null;
        const isIndexed = (row: ImportRow) => vector.get(row.id, embeddingModel) !== null;
        indexFresh(current, {
          fresh,
          current: () => !!currentDestination() && canWriteNow(session) && (canIndex?.() ?? true),
          needsVector: row => isLive(row) && !isIndexed(row),
        });
        const awaiting = new Set<Promise<void>>();
        const inFlight = pendingVectors.get(memory);
        for (const row of unique) {
          const task = inFlight?.get(row.id);
          if (task) awaiting.add(task);
        }
        const inspect = (): WorkerMemoryIndexStatus => {
          let lexical = 0;
          let indexed = 0;
          let live = 0;
          let pending = 0;
          for (const row of unique) {
            if (!isLive(row)) continue;
            live++;
            if (/[\p{L}\p{N}]/u.test(row.content) && lexicalMatch.get(`"${row.content.replaceAll('"', '""')}"`, row.id)) lexical++;
            if (!disabled && isIndexed(row)) indexed++;
            else if (!disabled && inFlight?.has(row.id)) pending++;
          }
          return { lexical, indexed, disabled: disabled ? live : 0, pending, deferred: disabled ? 0 : live - indexed - pending };
        };
        const confirmation = awaiting.size ? Promise.allSettled(awaiting).then(() => {
          if (currentDestination()) return withoutLockWait(db, inspect);
        }) : undefined;
        return {
          inserted: fresh.length, skipped: rows.length - fresh.length, rejected: records.length - rows.length,
          ...inspect(), ...(confirmation ? { confirmation } : {}),
        };
      });
    },
  };
}

class WorkerMemoryImportError extends Error {}
