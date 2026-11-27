import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { safeWorkerMemoryText, WORKER_MEMORY_ROWS } from "./worker-memory-page";
import { WorkerRefusal } from "./worker-request";

export type WorkerFactTool = "retain" | "learn";
export type WorkerFactCarrier = WorkerFactTool | "bash";
export type WorkerFactOrigin = { readonly sessionId: string; readonly bank: string };
type FactBatch = readonly (string | null)[];
export type WorkerFactEntry =
  | { readonly kind: "direct"; readonly tool: WorkerFactTool; readonly batch: FactBatch }
  | { readonly kind: "mounted"; readonly tool: WorkerFactTool; readonly command: string };
const maxProofs = 65_536;
const hexDigest = /^[0-9a-f]{64}$/u;
const proofTable = "CREATE TABLE worker_fact_proofs (position INTEGER PRIMARY KEY, digest TEXT NOT NULL) STRICT";
const proofIndex = "CREATE UNIQUE INDEX worker_fact_proofs_digest ON worker_fact_proofs(digest)";

export function workerFactDigest(origin: WorkerFactOrigin, tool: WorkerFactTool, text: string): string {
  return createHash("sha256").update(JSON.stringify(["worker-native-fact-v1", origin.sessionId, origin.bank, tool, text])).digest("hex");
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only recognized direct native project inputs; never examine context or skill bodies. */
export function workerFactBatch(origin: WorkerFactOrigin, tool: WorkerFactTool, input: unknown): FactBatch | undefined {
  if (!record(input)) return undefined;
  const fact = (text: unknown) => typeof text === "string" && safeWorkerMemoryText(text) ? workerFactDigest(origin, tool, text) : null;
  if (tool === "learn")
    return input.skill === undefined && (input.scope === undefined || input.scope === "project") && typeof input.memory === "string"
      ? [fact(input.memory)] : undefined;
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > WORKER_MEMORY_ROWS) return undefined;
  const batch: (string | null)[] = [];
  for (const item of input.items) {
    if (!record(item) || typeof item.content !== "string" || (item.scope !== undefined && item.scope !== "project")) return undefined;
    batch.push(fact(item.content));
  }
  return batch;
}

export function nativeFactSuccess(tool: WorkerFactTool, details: unknown, length: number): boolean {
  return record(details) && Object.keys(details).length === 1
    && (tool === "retain" ? details.count === length : details.skill === null);
}

export function isWorkerFactRoot(
  context: { readonly agent: { readonly kind: string; readonly id: string }; readonly sessionManager: object },
  rootAgent: string, rootSession: object,
): boolean {
  return context.agent.kind === "main" && context.agent.id === rootAgent && context.sessionManager === rootSession;
}

// Reject shell programs, interpolation and extra commands. Literal quoted tool
// arguments (including the stock JSON form) are still interpreted only by OMP.
function literalWorkerFactCommand(command: string): WorkerFactTool | undefined {
  const match = /^[ \t]*(retain|learn)(?=[ \t]|$)/u.exec(command);
  if (!match || /^[ \t]*(?:retain|learn)[ \t]+(?:--help|-h)(?:[ \t]|$)/u.test(command)) return;
  let quote: "'" | '"' | undefined;
  let word = "";
  // Stock tool-cli expands @file and '-' before building its typed receipt.
  // Check the literal argv spelling as well as the resulting native call.
  const inline = () => !/^(?:--[^=]+=)?(?:@|-$)/u.test(word);
  for (let i = match[0].length; i < command.length; i++) {
    const character = command.charAt(i);
    if (quote === "'") {
      if (character === quote) quote = undefined;
      else word += character;
    } else if (character === "\\") {
      const escaped = command[++i];
      if (!escaped || escaped === "\n" || escaped === "\r" || escaped === "\0") return;
      word += escaped;
    } else if (character === quote) {
      quote = undefined;
    } else if (character === "$" || character === "`" || character === "\0") {
      return;
    } else if (!quote) {
      if (character === "'" || character === '"') quote = character;
      else if (character === " " || character === "\t") {
        if (!inline()) return;
        word = "";
      }
      else if (/[;&|<>()*?[{}~#!\r\n]/u.test(character)) return;
      else word += character;
    } else word += character;
  }
  if (!quote && inline()) return match[1] === "retain" ? "retain" : "learn";
}

function mountedWorkerFact(input: unknown): { readonly tool: WorkerFactTool; readonly command: string } | undefined {
  if (!record(input) || typeof input.command !== "string" || input.command.length > 64 * 1024
    || Buffer.byteLength(input.command) > 64 * 1024
    || (input.pty !== undefined && input.pty !== false) || (input.async !== undefined && input.async !== false)
    || input.cwd !== undefined || input.name !== undefined) return;
  const tool = literalWorkerFactCommand(input.command.trimEnd());
  if (tool) return { tool, command: input.command };
}

/** Cheap admission only when the private profile exists but the source is not yet bound. */
export function canBeginWorkerFact(carrier: WorkerFactCarrier, input: unknown): boolean {
  return carrier === "bash" ? mountedWorkerFact(input) !== undefined : record(input);
}

export function workerFactEntry(origin: WorkerFactOrigin, carrier: WorkerFactCarrier, input: unknown): WorkerFactEntry | undefined {
  if (carrier !== "bash") {
    const batch = workerFactBatch(origin, carrier, input);
    if (batch?.some(digest => digest !== null)) return { kind: "direct", tool: carrier, batch };
    return;
  }
  const mounted = mountedWorkerFact(input);
  if (mounted) return { kind: "mounted", tool: mounted.tool, command: createHash("sha256").update(mounted.command).digest("hex") };
}

/** The parent must be a proven stock Bash execution. Shell output is never a receipt. */
export function workerFactResult(origin: WorkerFactOrigin, entry: WorkerFactEntry, details: unknown): FactBatch | undefined {
  if (entry.kind === "direct")
    return nativeFactSuccess(entry.tool, details, entry.batch.length) ? entry.batch : undefined;
  if (!record(details) || details.async !== undefined || details.timedOut === true
    || (details.exitCode !== undefined && details.exitCode !== 0)
    || !Array.isArray(details.toolCommands) || details.toolCommands.length !== 1) return;
  const dispatch: unknown = details.toolCommands[0];
  if (!record(dispatch) || dispatch.tool !== entry.tool || dispatch.mode !== "execute" || dispatch.exitCode !== 0
    || dispatch.tier !== "read" || dispatch.readOnlyHint !== undefined) return;
  const batch = workerFactBatch(origin, entry.tool, dispatch.args);
  if (batch && batch.some(digest => digest !== null) && nativeFactSuccess(entry.tool, dispatch.inner, batch.length)) return batch;
}

function sameBatch(left: FactBatch, right: FactBatch): boolean {
  return left.length === right.length && left.every((digest, i) => digest === right[i]);
}

export function sameWorkerFactEntry(left: WorkerFactEntry, right: WorkerFactEntry): boolean {
  return left.tool === right.tool && (left.kind === "direct"
    ? right.kind === "direct" && sameBatch(left.batch, right.batch)
    : right.kind === "mounted" && left.command === right.command);
}

export function sameWorkerFactResult(expected: FactBatch, observed: FactBatch | undefined): boolean {
  return observed !== undefined && sameBatch(expected, observed);
}

/** Reserve this once, alongside a fresh worker bank, without adopting existing data. */
export function reserveWorkerFactProofs(path: string): string {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}`;
    using store = openWorkerFactProofs(path, identity, true);
    store.db.exec(`PRAGMA synchronous = FULL; PRAGMA journal_mode = DELETE; ${proofTable}; ${proofIndex};`);
    store.check();
    return identity;
  } finally { closeSync(fd); }
}

function openWorkerFactProofs(path: string, identity: string, write: boolean) {
  for (const suffix of ["-wal", "-shm"])
    if (lstatSync(path + suffix, { throwIfNoEntry: false })) throw new WorkerRefusal("Worker fact proofs are unavailable");
  const journal = `${path}-journal`;
  const rollback = lstatSync(journal, { bigint: true, throwIfNoEntry: false });
  if (rollback && (!write || !rollback.isFile() || rollback.nlink !== 1n
    || rollback.uid !== BigInt(process.getuid?.() ?? -1) || (rollback.mode & 0o777n) !== 0o600n
    || rollback.size > 16n * 1024n * 1024n || realpathSync(journal) !== journal))
    throw new WorkerRefusal("Worker fact proof rollback is unavailable");
  const access = write ? constants.O_RDWR : constants.O_RDONLY;
  const fd = openSync(path, access | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const expected = fstatSync(fd, { bigint: true });
    const check = () => {
      checkedProofFile(path, identity);
      if (`${expected.dev}:${expected.ino}` !== identity) throw new WorkerRefusal("Worker fact proofs are unavailable");
    };
    check();
    if (expected.size > 0n) {
      const header = Buffer.alloc(20);
      if (readSync(fd, header, 0, header.length, 0) !== header.length
        || header.toString("ascii", 0, 16) !== "SQLite format 3\u0000" || header[18] !== 1 || header[19] !== 1)
        throw new WorkerRefusal("Worker fact proof journal mode is unavailable");
    }
    const db = new Database(path, { readonly: !write, strict: true });
    try {
      check();
      db.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 0;");
      return { db, check, [Symbol.dispose]() { db.close(); } };
    } catch (error) {
      db.close();
      throw error;
    }
  } finally { closeSync(fd); }
}

function checkedProofFile(path: string, identity: string) {
  const actual = lstatSync(path, { bigint: true });
  if (!actual.isFile() || actual.nlink !== 1n || actual.uid !== BigInt(process.getuid?.() ?? -1)
    || (actual.mode & 0o777n) !== 0o600n || `${actual.dev}:${actual.ino}` !== identity
    || actual.size > 16n * 1024n * 1024n || realpathSync(path) !== path)
    throw new WorkerRefusal("Worker fact proofs are unavailable");
  return actual;
}

function validateProofSchema(db: Database) {
  using schema = db.prepare<{ type: string; sql: string }, []>("SELECT type, sql FROM main.sqlite_schema LIMIT 3");
  const objects = schema.all();
  if (objects.length !== 2 || !objects.some(item => item.type === "table" && item.sql === proofTable)
    || !objects.some(item => item.type === "index" && item.sql === proofIndex))
    throw new WorkerRefusal("Worker fact proof schema is unavailable");
}

/** Private coordination witness. The stock memory bank is never modified. */
export function workerFactProofs(path: string, identity: string) {
  return {
    recover() {
      if (!lstatSync(`${path}-journal`, { throwIfNoEntry: false })) return;
      using store = openWorkerFactProofs(path, identity, true);
      // Only SQLite can decide whether this private rollback is hot. Never
      // unlink it or interpret another file as the reserved database.
      store.db.transaction(() => validateProofSchema(store.db)).immediate();
      store.check();
    },
    version() {
      for (const suffix of ["-wal", "-shm", "-journal"])
        if (lstatSync(path + suffix, { throwIfNoEntry: false })) throw new WorkerRefusal("Worker fact proofs are unavailable");
      const file = checkedProofFile(path, identity);
      return `${identity}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
    },
    seal(batch: FactBatch) {
      if (batch.length > WORKER_MEMORY_ROWS || batch.some(digest => digest !== null && (digest.length !== 64 || !hexDigest.test(digest))))
        throw new WorkerRefusal("Worker fact proof format is invalid");
      if (!batch.some(item => item !== null)) return;
      using store = openWorkerFactProofs(path, identity, true);
      const { db } = store;
      db.exec("PRAGMA synchronous = FULL;");
      db.transaction(() => {
        validateProofSchema(db);
        using write = db.prepare("INSERT OR IGNORE INTO worker_fact_proofs(digest) VALUES (?)");
        using count = db.prepare<{ position: number }, []>("SELECT max(position) AS position FROM worker_fact_proofs");
        const position = count.get()?.position ?? 0;
        for (const digest of batch.slice(0, Math.max(0, maxProofs - position)))
          if (digest !== null) write.run(digest);
      }).immediate();
      store.check();
    },
    lookup() {
      const store = openWorkerFactProofs(path, identity, false);
      try {
        store.db.exec("BEGIN");
        validateProofSchema(store.db);
        const query = store.db.prepare("SELECT 1 FROM main.worker_fact_proofs INDEXED BY worker_fact_proofs_digest WHERE digest = ?");
        return {
          has(digest: string) { return !!query.get(digest); },
          check: store.check,
          [Symbol.dispose]() { try { query.finalize(); } finally { store[Symbol.dispose](); } },
        };
      } catch (error) {
        store[Symbol.dispose]();
        throw error;
      }
    },
  };
}
