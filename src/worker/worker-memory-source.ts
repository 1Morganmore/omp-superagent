import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { lookup as lookupSetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/memory-backend";
import { nativeMemoryProjectCwd } from "../omp/native-sessions";
import { isWorkerMemoryCursor, isWorkerMemoryStamp, parseWorkerMemoryPage, safeWorkerMemoryText, workerMemoryId,
  WORKER_MEMORY_PAGE_BYTES, WORKER_MEMORY_ROWS, WORKER_MEMORY_TEXT_BYTES, type WorkerMemoryRecord } from "./worker-memory-page";
import { checkWorkerMemoryFiles, readWorkerMemoryIdentity, workerMemoryPaths } from "./worker-memory-storage";
import { ownsCheckout } from "./worker-checkout";
import { sameWorkerFactEntry, sameWorkerFactResult, workerFactDigest, workerFactEntry, workerFactProofs, workerFactResult,
  type WorkerFactCarrier, type WorkerFactEntry, type WorkerFactTool } from "./worker-memory-proofs";
import { workerMemoryCheckoutStamp, workerMemoryRepositoryMatches } from "./worker-repository";
import { WorkerRefusal } from "./worker-request";

const memoryScanRows = 64;
const metadataBytes = 8192;
const journalTailBytes = 128 * 1024;
type NativeMemory = Pick<MnemopiSessionState["memory"], "beam" | "get">;
type MemoryOrigin = { readonly sessionId: string; readonly cwd: string; readonly bank: string;
  readonly attempt: string; readonly bankFile: string };
type Candidate = { readonly at: number; readonly id: string | null };
type PageRequest = { readonly after: number; readonly unchanged?: string };
type Proofs = ReturnType<typeof workerFactProofs>;
type FactBatch = NonNullable<ReturnType<typeof workerFactResult>>;
type FactReturn = { readonly entry: WorkerFactEntry; readonly batch: FactBatch };
type FactObservation = { readonly carrier: WorkerFactCarrier; started?: WorkerFactEntry; returned?: FactReturn;
  checkout?: { readonly stamp: string; readonly verified: Promise<boolean> } };

function unavailable(): never {
  throw new WorkerRefusal("Worker memory is unavailable");
}

function originContent(raw: unknown, id: string, origin: MemoryOrigin): {
  readonly content: string; readonly tool: WorkerFactTool;
} | null {
  if (!raw || typeof raw !== "object" || !("memory_store" in raw) || raw.memory_store !== "working"
    || !("id" in raw) || raw.id !== id || !("veracity" in raw) || raw.veracity !== "tool"
    || !("session_id" in raw) || raw.session_id !== origin.bank || !("source" in raw)
    || (raw.source !== "coding-agent-retain" && raw.source !== "coding-agent-learn")
    || !("metadata_json" in raw) || typeof raw.metadata_json !== "string"
    || Buffer.byteLength(raw.metadata_json, "utf8") > metadataBytes
    || !("valid_until" in raw) || raw.valid_until !== null || !("superseded_by" in raw) || raw.superseded_by !== null
    || !("content" in raw) || typeof raw.content !== "string" || !safeWorkerMemoryText(raw.content)) return null;
  let metadata: unknown;
  try { metadata = JSON.parse(raw.metadata_json); }
  catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!metadata || typeof metadata !== "object" || Object.keys(metadata).length !== 4
    || !("session_id" in metadata) || metadata.session_id !== origin.sessionId
    || !("cwd" in metadata) || metadata.cwd !== origin.cwd
    || !("context" in metadata) || (metadata.context !== null && typeof metadata.context !== "string")
    || !("tool" in metadata) || (raw.source === "coding-agent-retain" ? metadata.tool !== "retain" : metadata.tool !== "learn")) return null;
  return { content: raw.content, tool: metadata.tool === "retain" ? "retain" : "learn" } as const;
}

/** SQLite only locates bounded candidate IDs. The native row API supplies the content and origin. */
export function readWorkerMemoryPage(memory: NativeMemory, origin: MemoryOrigin & { readonly proofs: Proofs }, { after, unchanged }: PageRequest) {
  const { beam } = memory;
  if (!isWorkerMemoryCursor(after) || !beam.pendingExtractions || beam.pendingExtractions.size !== 0
    || (unchanged !== undefined && (after !== 0 || !isWorkerMemoryStamp(unchanged)))
    || beam.db.inTransaction) unavailable();
  return beam.db.transaction(() => {
    const { db } = beam;
    using total = db.prepare<{ changes: string }, []>("SELECT CAST(total_changes() AS TEXT) AS changes");
    using version = db.prepare<{ data_version: number }, []>("PRAGMA main.data_version");
    const changes = total.get()?.changes;
    const dataVersion = version.get()?.data_version;
    if (typeof changes !== "string" || dataVersion === undefined || !Number.isSafeInteger(dataVersion)) unavailable();
    const proofVersion = origin.proofs.version();
    const stamp = createHash("sha256").update(JSON.stringify([origin.attempt, origin.bankFile, changes, dataVersion, proofVersion])).digest("hex");
    if (stamp === unchanged) return { after, next: 0, records: [], stamp };
    using table = db.prepare<{ type: string; wr: number }, []>("PRAGMA main.table_list('working_memory')");
    const layout = table.get();
    if (layout?.type !== "table" || layout.wr !== 0) unavailable();
    using shadow = db.prepare("PRAGMA temp.table_list('working_memory')");
    if (shadow.get()) unavailable();
    // No WHERE filter on origin in the keyset: bad rows still consume scan work.
    // Walk a bounded rowid range, then wrap to zero at end. Rowid is not identity;
    // edits, deletions, native dedupe and rowid reuse cannot permanently hide IDs.
    using keyset = db.prepare<Candidate, [string, number]>(`
      SELECT rowid AS at, CASE WHEN
        typeof(id) = 'text' AND octet_length(id) = 16
        AND scope = 'bank' AND session_id = ?1 AND channel_id = ?1
        AND author_id = 'coding-agent' AND author_type = 'agent'
        AND source IN ('coding-agent-retain', 'coding-agent-learn')
        AND veracity = 'tool' AND memory_type = 'fact' AND trust_tier = 'STATED'
        AND valid_until IS NULL AND superseded_by IS NULL
        AND typeof(content) = 'text' AND octet_length(content) BETWEEN 1 AND ${WORKER_MEMORY_TEXT_BYTES}
        AND typeof(metadata_json) = 'text' AND octet_length(metadata_json) BETWEEN 1 AND ${metadataBytes}
        AND octet_length(timestamp) <= 64 AND octet_length(created_at) <= 64
        THEN id ELSE NULL END AS id
      FROM main.working_memory WHERE rowid > ?2 ORDER BY rowid LIMIT ${memoryScanRows + 1}
    `);
    const keys = keyset.all(origin.bank, after);
    using proofs = origin.proofs.lookup();
    const records: WorkerMemoryRecord[] = [];
    let position = after;
    for (const { at, id } of keys.slice(0, memoryScanRows)) {
      if (!Number.isSafeInteger(at) || at <= position) unavailable();
      if (id && workerMemoryId.test(id)) {
        const found = originContent(memory.get(id), id, origin);
        if (found !== null && proofs.has(workerFactDigest(origin, found.tool, found.content))) {
          const { content } = found;
          const record = { at, id, content };
          const candidate = { after, next: at, records: [...records, record], stamp };
          if (records.length === WORKER_MEMORY_ROWS || Buffer.byteLength(JSON.stringify(candidate), "utf8") + 16 > WORKER_MEMORY_PAGE_BYTES) {
            if (origin.proofs.version() !== proofVersion) unavailable();
            return parseWorkerMemoryPage({ after, next: position, records, stamp }, after);
          }
          records.push(record);
        }
      }
      position = at;
    }
    if (origin.proofs.version() !== proofVersion) unavailable();
    return parseWorkerMemoryPage({ after, next: keys.length > memoryScanRows ? position : 0, records, stamp }, after);
  })();
}

function durableJournalTail(file: string, expectedId: string): boolean {
  if (realpathSync(file) !== file) return false;
  using journal = {
    fd: openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    [Symbol.dispose]() { closeSync(this.fd); },
  };
  const start = fstatSync(journal.fd, { bigint: true });
  if (!start.isFile() || start.uid !== BigInt(process.getuid?.() ?? -1) || start.nlink !== 1n
    || (start.mode & 0o022n) !== 0n || start.size > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  const length = Math.min(Number(start.size), journalTailBytes);
  const offset = Number(start.size) - length;
  const tail = Buffer.alloc(length);
  if (readSync(journal.fd, tail, 0, length, offset) !== length || tail.at(-1) !== 10) return false;
  const end = length - 1;
  const delimiter = end > 0 ? tail.lastIndexOf(10, end - 1) : -1;
  if (delimiter < 0 && offset > 0) return false;
  let row: unknown;
  try { row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(tail.subarray(delimiter + 1, end))); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return false;
    throw error;
  }
  const current = lstatSync(file, { bigint: true });
  return current.dev === start.dev && current.ino === start.ino && current.size === start.size
    && current.mtimeNs === start.mtimeNs && current.ctimeNs === start.ctimeNs
    && !!row && typeof row === "object" && "id" in row && row.id === expectedId;
}

/** Bind one live root's native memory object, native profile, journal, bank and file inode. */
export function bindWorkerMemorySource(session: AgentSession, binding: { readonly encoded: string; readonly file: string; readonly attempt: string }) {
  const { encoded, file, attempt } = binding;
  const identity = readWorkerMemoryIdentity(encoded);
  if (!identity.proof) unavailable();
  const paths = workerMemoryPaths({ ...identity, sessionFile: file });
  const journal = session.sessionManager;
  // The running CLI owns the effective descriptors. Compiled OMP exposes
  // its populated registry to extensions, not every SDK domain module.
  const backend = lookupSetting("memory.backend");
  const scoping = lookupSetting("mnemopi.scoping");
  const dbPath = lookupSetting("mnemopi.dbPath");
  if (!backend || !scoping || !dbPath) unavailable();
  // SQLite counters are scoped to an open connection. A setting transition
  // may reopen the same inode during one native attempt, resetting them.
  const origin = { sessionId: journal.getSessionId(), cwd: identity.cwd, bank: paths.bank, attempt,
    bankFile: `${identity.file}:${crypto.randomUUID()}`, proofs: workerFactProofs(paths.proofsPath, identity.proof) };
  if (typeof session.getMnemopiSessionState !== "function" || typeof journal.getEntriesView !== "function"
    || typeof journal.onPersistenceError !== "function") unavailable();
  const state = session.getMnemopiSessionState();
  if (!state || state.aliasOf || state.session !== session) unavailable();
  const memory = state.getScopedRetainTarget().memory;
  const claim = { gitDir: identity.checkout.gitDir, attempt };
  const checkoutStamp = () => ownsCheckout(claim) ? workerMemoryCheckoutStamp(origin.cwd, identity.checkout) : null;
  const verifiedCheckout = async (stamp: string) => {
    try {
      return checkoutStamp() === stamp && await workerMemoryRepositoryMatches(origin.cwd, identity.checkout)
        && checkoutStamp() === stamp;
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  };
  const nativePaths = () => {
    using databases = memory.beam.db.prepare<{ name: string; file: string }, []>("PRAGMA database_list");
    const open = databases.all();
    return open.find(entry => entry.name === "main")?.file === paths.dbPath
      && open.every(entry => entry.name === "main" || entry.name === "temp" && !entry.file);
  };
  const validate = () => {
    const config = state.config;
    const recall = state.getScopedRecallTargets();
    const settingsCwd = session.settings.getCwd();
    if (session.memoryEnabled !== true || backend.get(session.settings) !== "mnemopi"
      || scoping.get(session.settings) !== "per-project" || dbPath.get(session.settings) !== paths.base
      || session.getMnemopiSessionState() !== state || state.sessionId !== origin.sessionId
      || journal.getSessionId() !== origin.sessionId || journal.getSessionFile() !== file
      || journal.getCwd() !== origin.cwd || realpathSync(origin.cwd) !== origin.cwd
      || (settingsCwd !== origin.cwd && settingsCwd !== nativeMemoryProjectCwd(origin.cwd)) || realpathSync(settingsCwd) !== origin.cwd
      || session.settings.getAgentDir() !== identity.agentDir || realpathSync(identity.agentDir) !== identity.agentDir
      || config.dbPath !== paths.base || config.scoping !== "per-project" || config.retainBank !== origin.bank
      || !ownsCheckout(claim)
      || recall.length !== 1 || recall[0]?.memory !== memory || recall[0].bank !== origin.bank
      || state.getScopedRetainTarget().memory !== memory || typeof memory.get !== "function"
      || memory.beam?.dbPath !== paths.dbPath || memory.beam.sessionId !== origin.bank
      || !Number.isSafeInteger(memory.beam.pendingExtractions?.size)
      || typeof memory.beam.db?.transaction !== "function" || !nativePaths()) unavailable();
    checkWorkerMemoryFiles(paths, identity.file);
  };
  validate();
  // Older receipts have no witness. A fresh receipt still needs an exact
  // reserved file and schema before the native owner can advertise transfer.
  {
    using proof = origin.proofs.lookup();
    proof.check();
  }
  // Wrapper tool_result and the root's event stream may be scheduled
  // independently. Hold only bounded digests until the root's terminal event.
  const facts = new Map<string, FactObservation>();
  let pending = 0;
  let closed = false;
  const nativeTool = (tool: WorkerFactTool) => session.getAllToolInfos().some(info =>
    info.name === tool && info.sourceInfo.source === "builtin" && info.sourceInfo.path === `<builtin:${tool}>`);
  const observe = (carrier: WorkerFactCarrier, id: string, event: { readonly started: WorkerFactEntry } | { readonly returned: FactReturn }) => {
    if (!id || id.length > 256) return;
    const current = facts.get(id);
    if (current) {
      if (current.carrier !== carrier || ("started" in event ? current.started !== undefined : current.returned !== undefined))
        facts.delete(id);
      else Object.assign(current, event);
    } else if (facts.size + pending < WORKER_MEMORY_ROWS) facts.set(id, { carrier, ...event });
  };
  let journalFailed = false;
  const unsubscribe = journal.onPersistenceError(() => { journalFailed = true; });
  return {
    validate,
    close() { closed = true; facts.clear(); unsubscribe(); },
    clearFactStarts() { facts.clear(); },
    startFact(carrier: WorkerFactCarrier, id: string, input: unknown) {
      const entry = workerFactEntry(origin, carrier, input);
      if (!entry || (entry.kind === "mounted" && !nativeTool(entry.tool))) return;
      validate();
      const stamp = checkoutStamp();
      if (!stamp) return;
      observe(carrier, id, { started: entry });
      const observation = facts.get(id);
      if (observation?.started === entry && pending < WORKER_MEMORY_ROWS) {
        pending++;
        observation.checkout = { stamp, verified: verifiedCheckout(stamp).finally(() => { pending--; }) };
        // An asynchronous metadata read can finish after an interrupted start.
        void observation.checkout.verified.catch(() => {});
      }
    },
    returnFact(event: {
      readonly toolName: WorkerFactCarrier; readonly toolCallId: string; readonly parentToolCallId?: string;
      readonly isError: boolean; readonly input: unknown; readonly details?: unknown;
    }) {
      if (event.isError || event.parentToolCallId !== undefined) return;
      const entry = workerFactEntry(origin, event.toolName, event.input);
      if (!entry || (entry.kind === "mounted" && !nativeTool(entry.tool))) return;
      const batch = workerFactResult(origin, entry, event.details);
      if (!batch) return;
      validate();
      observe(event.toolName, event.toolCallId, { returned: { entry, batch } });
    },
    finishFact(carrier: WorkerFactCarrier, id: string, success: boolean, result: unknown) {
      const observation = facts.get(id);
      facts.delete(id);
      const { started, returned, checkout } = observation ?? {};
      if (!success || observation?.carrier !== carrier || !started || !returned || !sameWorkerFactEntry(started, returned.entry)
        || (started.kind === "mounted" && !nativeTool(started.tool)) || !result || typeof result !== "object"
        || !("details" in result) || !sameWorkerFactResult(returned.batch, workerFactResult(origin, started, result.details))
        || !checkout || pending >= WORKER_MEMORY_ROWS || checkoutStamp() !== checkout.stamp) return;
      validate();
      pending++;
      void Promise.all([checkout.verified, verifiedCheckout(checkout.stamp)]).then(([entered, completed]) => {
        if (closed || !entered || !completed || checkoutStamp() !== checkout.stamp) return;
        validate();
        origin.proofs.seal(returned.batch);
      }).catch(() => { /* An uncertain witness never affects a successful native write. */ })
        .finally(() => { pending--; });
    },
    async verifyCheckout() {
      const stamp = checkoutStamp();
      if (!stamp || !await verifiedCheckout(stamp)) unavailable();
    },
    page(request: PageRequest, hasRun: boolean) {
      validate();
      const last = journal.getEntriesView().at(-1)?.id ?? origin.sessionId;
      // Stock's first-turn background recall commits synchronously once this
      // flag is set. If a started run has not reached it, absence of work is unknown.
      if (pending !== 0 || journalFailed || (hasRun && state.config.autoRecall && !state.hasRecalledForFirstTurn)
        || !durableJournalTail(file, last)) unavailable();
      const page = readWorkerMemoryPage(memory, origin, request);
      return {
        page,
        assertCurrent() {
          validate();
          if (pending !== 0 || journalFailed || memory.beam.pendingExtractions.size !== 0
            || (journal.getEntriesView().at(-1)?.id ?? origin.sessionId) !== last) unavailable();
        },
      };
    },
  };
}
