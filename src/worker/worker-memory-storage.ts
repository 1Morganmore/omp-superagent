import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type, type Static } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";
import type { NativeProfile } from "../omp/native-sessions";
import { privateWorkerDirectory } from "./worker-checkout";
import { reserveWorkerFactProofs, workerFactProofs } from "./worker-memory-proofs";
import { WorkerRefusal } from "./worker-request";

export const WORKER_MEMORY_WIRE_ENV = "OMP_SUPERAGENT_WORKER_MEMORY_WIRE";
export const WORKER_MEMORY_ENV = "OMP_SUPERAGENT_WORKER_MEMORY";
export const WORKER_MEMORY_PROFILE_ENV = "OMP_SUPERAGENT_WORKER_MEMORY_PROFILE";
const strict = { additionalProperties: false } as const;
const storageKey = Type.String({ pattern: "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\\s\\S])" });
const bankFile = Type.String({ pattern: "^[0-9]+:[0-9]+(?![\\s\\S])" });
const bankName = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+(?![\\s\\S])" });
export const workerMemoryBinding = Type.Object({
  key: storageKey,
  profile: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  bank: bankName,
  file: bankFile,
  proof: Type.Optional(bankFile),
}, strict);
export type WorkerMemoryBinding = Readonly<Static<typeof workerMemoryBinding>>;
const checkout = Type.Object({
  repoRoot: Type.String({ minLength: 1, maxLength: 4096 }),
  gitDir: Type.String({ minLength: 1, maxLength: 4096 }),
  repoId: Type.String({ pattern: "^[0-9a-f]{64}(?![\\s\\S])" }),
  revision: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\\s\\S])" }),
  subdir: Type.String({ maxLength: 2048 }),
}, strict);
export type WorkerMemoryCheckout = Readonly<Static<typeof checkout>>;
export type WorkerMemoryLaunch = {
  readonly key: string;
  readonly checkout: WorkerMemoryCheckout;
  readonly previous?: WorkerMemoryBinding;
};
export type WorkerMemoryPlan = { readonly bank: string; readonly profile: NativeProfile };
const identity = Type.Object({ key: storageKey, bank: bankName, file: bankFile, proof: Type.Optional(bankFile),
  agentDir: Type.String(), cwd: Type.String(), checkout }, strict);
type MemoryIdentity = Readonly<Static<typeof identity>>;

export function readWorkerMemoryIdentity(encoded: string): MemoryIdentity {
  const value: unknown = JSON.parse(encoded);
  if (!Value.Check(identity, value)) throw new WorkerRefusal("Worker memory launch identity is invalid");
  return value;
}

type MemoryLocation = {
  readonly key: string;
  readonly bank: string;
  readonly sessionFile: string;
};

export function workerMemoryPaths({ key, bank, sessionFile }: MemoryLocation) {
  if (!Value.Check(storageKey, key) || !Value.Check(bankName, bank) || bank === "default")
    throw new WorkerRefusal("Invalid worker memory location");
  const sessionDir = dirname(sessionFile);
  const dir = join(sessionDir, `memory-${key}`);
  const base = join(dir, "mnemopi.db");
  const banks = join(dir, "banks");
  const bankDir = join(banks, bank);
  return { sessionDir, dir, base, banks, bankDir, bank, dbPath: join(bankDir, "mnemopi.db"),
    blobs: join(dir, "blobs"), proofsPath: join(dir, "fact-proofs.sqlite") };
}

function ownedMemoryFile(file: string) {
  const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid?.() ?? -1)
    || (stat.mode & 0o022n) !== 0n || realpathSync(file) !== file)
    throw new WorkerRefusal("Worker memory contains a non-private file");
  return `${stat.dev}:${stat.ino}`;
}

export function checkWorkerMemoryFiles(paths: ReturnType<typeof workerMemoryPaths>, expected: string): void {
  for (const directory of [paths.sessionDir, paths.dir, paths.banks, paths.bankDir, paths.blobs])
    if (!privateWorkerDirectory(directory)) throw new WorkerRefusal("Worker memory directory is unavailable");
  if (ownedMemoryFile(paths.base) !== undefined || ownedMemoryFile(paths.dbPath) !== expected)
    throw new WorkerRefusal("Worker memory database identity changed");
  for (const suffix of ["-wal", "-shm", "-journal"]) ownedMemoryFile(`${paths.dbPath}${suffix}`);
  // Native recall may discover legacy sibling banks. There must be none.
  const entries = opendirSync(paths.banks);
  try {
    if (entries.readSync()?.name !== paths.bank || entries.readSync() !== null)
      throw new WorkerRefusal("Worker memory must contain only its private bank");
  } finally { entries.closeSync(); }
}

export function prepareWorkerMemory(request: WorkerMemoryLaunch, launch: {
  readonly sessionFile: string; readonly cwd: string;
}, plan: WorkerMemoryPlan) {
  const { bank, profile: { agentDir, dataDir, sessionsDir } } = plan;
  const profile = createHash("sha256").update(JSON.stringify([agentDir, dataDir, sessionsDir])).digest("hex");
  if (request.previous && (request.previous.profile !== profile || request.previous.bank !== bank
    || request.previous.key !== request.key))
    throw new WorkerRefusal("Worker memory native profile or bank changed");
  const paths = workerMemoryPaths({ key: request.key, bank, sessionFile: launch.sessionFile });
  let file = request.previous?.file;
  let proof = request.previous?.proof;
  if (file === undefined) {
    // The random lane-owned directory must be new. Never adopt an existing store.
    for (const directory of [paths.dir, paths.banks, paths.bankDir, paths.blobs]) mkdirSync(directory, { mode: 0o700 });
    const fd = openSync(paths.dbPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd, { bigint: true });
      file = `${stat.dev}:${stat.ino}`;
    } finally { closeSync(fd); }
    proof = reserveWorkerFactProofs(paths.proofsPath);
  }
  checkWorkerMemoryFiles(paths, file);
  if (request.previous && proof) {
    try { workerFactProofs(paths.proofsPath, proof).recover(); }
    catch (error) {
      // Damaged optional evidence cannot keep the original private bank or
      // its native workload from opening. Live evidence checks will refuse.
      if (!(error instanceof Error)) throw error;
    }
  }
  return {
    binding: { key: request.key, bank, profile, file, ...(proof && { proof }) },
    config: { mnemopi: { dbPath: paths.base } },
    env: {
      [WORKER_MEMORY_ENV]: JSON.stringify({ key: request.key, bank, file, proof, agentDir, cwd: launch.cwd, checkout: request.checkout }),
      MNEMOPI_DATA_DIR: paths.dir,
      MNEMOPI_BLOB_DIR: paths.blobs,
    },
  };
}
