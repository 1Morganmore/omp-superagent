import * as fs from "node:fs/promises";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getAgentDbPath, getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import { readSessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";

export const NATIVE_PROFILE_ENV = "OMP_SUPERAGENT_NATIVE_PROFILE";

export type NativeProfilePaths = {
  readonly agentDir: string;
  readonly dataDir: string;
  readonly sessionsDir: string;
};

export type NativeProfile = NativeProfilePaths & { readonly version: 2 };

export type NativeProfileBinding = {
  readonly profile: NativeProfile;
  readonly discoveryEntry: string;
};

export type HostReadyEvent = {
  readonly pid: number;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly nativeProfile?: NativeProfile;
  readonly waking?: boolean;
};

export function sdkNativeProfilePaths(agentDir = getAgentDir()): NativeProfilePaths {
  return { agentDir, dataDir: dirname(getAgentDbPath(agentDir)), sessionsDir: getSessionsDir() };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Resolve through existing ancestors without creating directories or accepting dangling symlinks. */
function canonicalDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("Native profile paths must be absolute");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return join(canonicalDirectory(dirname(path)), basename(path));
  const canonical = realpathSync(path);
  if (!(stat.isSymbolicLink() ? statSync(canonical) : stat).isDirectory())
    throw new Error("Native profile path is not a directory");
  return canonical;
}

export function resolveNativeProfile(paths: NativeProfilePaths): NativeProfile {
  return { version: 2, agentDir: canonicalDirectory(paths.agentDir), dataDir: canonicalDirectory(paths.dataDir),
    sessionsDir: canonicalDirectory(paths.sessionsDir) };
}

export function matchesNativeProfile(paths: NativeProfilePaths, profile: NativeProfile): boolean {
  return isDeepStrictEqual(resolveNativeProfile(paths), profile);
}

/** Use the injected stock SDK, not a second resolver from node_modules. */
export async function bindNativeProfile(
  native: Pick<typeof import("@oh-my-pi/pi-coding-agent"), "findSessionFiles" | "getAgentDir">,
  session: { readonly agentDir: string; readonly file: string; readonly id: string },
  binding: NativeProfileBinding,
): Promise<NativeProfilePaths> {
  const mismatch = () => new Error("Running native Host does not match the prepared agent, data and discovery roots");
  if (native.getAgentDir() !== session.agentDir) throw mismatch();
  const source = realpathSync(session.file);
  const preparedBucket = dirname(binding.discoveryEntry);
  if (dirname(preparedBucket) !== binding.profile.sessionsDir || canonicalDirectory(preparedBucket) !== preparedBucket
    || realpathSync(binding.discoveryEntry) !== source) throw mismatch();
  // Unlike getDefaultSessionDir, the stock search does not create project
  // buckets or migrate files. Its default root is the native process's data
  // partition, independent of the npm SDK's ambient directory resolver. It
  // may deduplicate legitimate aliases, so compare the owned journal itself.
  for (const entry of await native.findSessionFiles(session.id)) {
    const sessionsDir = dirname(dirname(entry));
    const paths = { agentDir: session.agentDir, dataDir: dirname(sessionsDir), sessionsDir };
    if (matchesNativeProfile(paths, binding.profile) && realpathSync(entry) === source) return paths;
  }
  throw mismatch();
}

/** Stock OMP follows leaf session links for discovery and writes through them. */
export async function publishNativeSession(
  sessionFile: string, cwd: string, expectedId?: string, profile = resolveNativeProfile(sdkNativeProfilePaths()),
): Promise<string | undefined> {
  const info = await readSessionInfo(sessionFile);
  if (!info) return;
  if (expectedId !== undefined && (info.id !== expectedId || info.cwd !== cwd))
    throw new Error("Refusing to publish a journal with a different managed session identity");
  const source = await fs.realpath(sessionFile);
  const directory = sessionDirForCwd(cwd, profile.sessionsDir);
  const target = join(directory, `${info.created.toISOString().replace(/[:.]/g, "-")}_${info.id}.jsonl`);
  if (target === source) return target;

  const requireBucket = () => {
    if (!matchesNativeProfile(profile, profile) || canonicalDirectory(directory) !== directory)
      throw new Error("Native discovery directory no longer belongs to the prepared profile");
  };
  requireBucket();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const link = async (original: string, destination: string) => {
    requireBucket();
    try { await fs.symlink(original, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fs.readlink(destination).catch(error => {
        if (isMissing(error) || (error instanceof Error && "code" in error && error.code === "EINVAL")) return;
        throw error;
      });
      if (!existing || resolve(dirname(destination), existing) !== original)
        throw new Error(`Native session discovery path already belongs to another file: ${destination}`);
    }
  };
  // The resumed session must keep its original spill artifacts and child journals.
  if (source.endsWith(".jsonl")) {
    const artifacts = source.slice(0, -".jsonl".length);
    await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
    await link(artifacts, target.slice(0, -".jsonl".length));
  }
  await link(source, target);
  return target;
}
