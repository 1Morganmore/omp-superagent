import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checked } from "./npm-upgrade-process";

const released = {
  version: "0.1.10", sdk: "19.1.1",
  integrity: "sha512-NbUnaLlzg94kVHEgZLzeAR1QswmmNdaxU+cP4bpumB3FA3vOF17xaroiMe8hEt1OWjZyTja1+VlvmDsjHqGeng==",
} as const;
const oldOmp = {
  "darwin-arm64": "d5a3324acd98375a01698a1b0c018be48caed2956c8aa9044ad137fe43bc0400",
  "darwin-x64": "6ffecb22a9fe01a98f90f91a2ef04a697850a23bf4dde83adad2fe80e51a8353",
  "linux-arm64": "f022f720c4899eb24c6e5e34dcbbae98ae05f5532bb03e97dffc02cfc8dd9a6f",
  "linux-x64": "04e9490f9394da6d6804474cc2e41eb3d18f8e26215df4b34bdd4ad4c0d8a401",
} as const;
const omp1921 = {
  "darwin-arm64": "43943119837612b2da72250ab7efe22ff8ca239eabebd4f702f34e3a144fdd3d",
  "darwin-x64": "4face26750f5679857a606a61df22b1587925d4b308d5938de470d8c780cd871",
  "linux-arm64": "92d4cce4b14814f6b838aa86dcec6359f0cb089cbcc300e8463cbb5326991fe0",
  "linux-x64": "e8b937f9bf023baa147bdd300ad5421af0a6ef8b1f350c47a9a93d5fca94feca",
} as const;
type Target = keyof typeof oldOmp;
type Package = {
  readonly name: string; readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
};
const sdk = "@oh-my-pi/pi-coding-agent";
const managedRoot = ".upstream/ulw";

function isTarget(value: string): value is Target {
  return Object.hasOwn(oldOmp, value);
}

async function checksum(path: string, algorithm: "sha512" | "sha256", encoding: "base64" | "hex"): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest(encoding);
}

async function download(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  assert(response.ok, `${url}: HTTP ${response.status}`);
  return response;
}

async function getFile(path: string, cache: string | undefined, url: string) {
  if (cache) await copyFile(cache, path);
  else await Bun.write(path, await download(url));
}

async function omp(version: string, platform: Target, workspace: { readonly root: string; readonly cache?: string }) {
  assert.match(version, /^\d+\.\d+\.\d+$/, "The OMP SDK must pin an exact release");
  const asset = `omp-${platform}`;
  const url = `https://github.com/can1357/oh-my-pi/releases/download/v${version}`;
  const name = `omp-${version}-${platform}`;
  const destination = join(workspace.root, name);
  const expected = version === released.sdk ? oldOmp[platform] : version === "19.2.1" ? omp1921[platform] :
    (await (await download(`${url}/SHA256SUMS.txt`)).text()).split("\n")
      .find(line => line.endsWith(`  ${asset}`))?.split(" ")[0];
  assert(expected && /^[a-f0-9]{64}$/.test(expected), `No official checksum for OMP ${version} ${platform}`);
  await getFile(destination, workspace.cache && join(workspace.cache, name), `${url}/${asset}`);
  assert.equal(await checksum(destination, "sha256", "hex"), expected, `Stock OMP ${version} integrity`);
  await chmod(destination, 0o700);
  return destination;
}

export async function prepareArtifacts(options: {
  readonly root: string; readonly candidate: string; readonly platform: string; readonly cache?: string;
}) {
  const { root, candidate, platform, cache } = options;
  assert(isTarget(platform) && platform === `${process.platform}-${process.arch}`, `Wrong runner for ${platform}`);
  const manifest: Package = await Bun.file(join(import.meta.dir, "../../package.json")).json();
  assert.equal(manifest.name, "omp-superagent");
  assert.notEqual(manifest.version, released.version, "The candidate must be newer than the baseline");
  assert(await Bun.file(candidate).exists(), `Candidate tarball missing: ${candidate}`);
  const oldTarball = join(root, "old.tgz");
  await getFile(oldTarball, cache && join(cache, "old.tgz"), "https://registry.npmjs.org/omp-superagent/-/omp-superagent-0.1.10.tgz");
  assert.equal(`sha512-${await checksum(oldTarball, "sha512", "base64")}`, released.integrity, "Published npm tarball integrity");
  const candidateIntegrity = `sha512-${await checksum(candidate, "sha512", "base64")}`;
  const candidateSdk = manifest.dependencies[sdk];
  const oldCli = await omp(released.sdk, platform, options);
  const candidateCli = candidateSdk === released.sdk ? oldCli : await omp(candidateSdk, platform, options);
  return {
    old: { path: oldTarball, version: released.version, sdk: released.sdk, integrity: released.integrity, omp: oldCli },
    candidate: { path: candidate, version: manifest.version, sdk: candidateSdk, integrity: candidateIntegrity, omp: candidateCli },
  };
}

type Artifact = Awaited<ReturnType<typeof prepareArtifacts>>["old" | "candidate"];

export async function installArtifact(artifact: Artifact, options: {
  readonly prefix: string; readonly platform: string; readonly env: Record<string, string>;
}) {
  const { prefix, platform, env } = options;
  const nodeModules = join(prefix, "node_modules");
  const destination = join(nodeModules, "omp-superagent");
  await checked(["npm", "install", "--ignore-scripts=false", "--foreground-scripts",
    "--no-audit", "--no-fund", "--save-exact", artifact.path], { cwd: prefix, env, timeout: 300_000 });
  const installed: Package = await Bun.file(join(destination, "package.json")).json();
  assert.equal(installed.name, "omp-superagent");
  assert.equal(installed.version, artifact.version);
  assert.equal(installed.dependencies[sdk], artifact.sdk);
  const managed = await readManagedIdentity(join(destination, managedRoot));
  const lock: { readonly packages: Readonly<Record<string, { readonly integrity?: string }>> } =
    await Bun.file(join(prefix, "package-lock.json")).json();
  assert.equal(lock.packages["node_modules/omp-superagent"]?.integrity, artifact.integrity, "npm installed a different tarball");
  for (const [name, requested] of Object.entries(installed.dependencies)) {
    if (!name.startsWith("@oh-my-pi/")) continue;
    const nested = Bun.file(join(destination, "node_modules", name, "package.json"));
    const resolved: Package = await (await nested.exists() ? nested : Bun.file(join(nodeModules, name, "package.json"))).json();
    assert.equal(resolved.name, name);
    assert.equal(resolved.version, requested, `Installed ${name} is not from ${artifact.version}'s SDK dependency graph`);
  }
  for (const path of [
    join(nodeModules, ".bin", "omp-sa"), join(destination, "host-owner", "bin", `omp-host-owner-${platform}`),
    join(destination, "gateway", "bin", `omp-gateway-${platform}`),
  ]) await access(path, constants.X_OK);
  assert.equal(await checked([artifact.omp, "--version"], { cwd: prefix, env }), `omp/${artifact.sdk}`);
  const directory = await ownedDirectory(destination);
  assert(directory, "npm did not leave an owned package directory");
  return { destination, command: join(nodeModules, ".bin", "omp-sa"), directory, managed };
}

export async function verifyInstalledExitRefusal(destination: string, options: {
  readonly root: string; readonly env: Record<string, string>;
}) {
  // Check the actual npm payload without leaving a live predecessor fenced.
  const probe = join(options.root, "unsupported-exit");
  await mkdir(probe, { mode: 0o700 });
  const manifest = join(probe, "owner.json");
  await privateJson(manifest, { options: { socketPath: join(probe, "main.sock") } });
  const helper = Bun.spawn([process.execPath, "--no-env-file", join(destination, "src", "host-sdk-helper.ts"), "exit", manifest],
    { cwd: probe, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const [exit, stdout, stderr] = await Promise.all([helper.exited, helper.stdout.text(), helper.stderr.text()]);
  assert.deepEqual({ exit, stdout, stderr: stderr.trimEnd() },
    { exit: 1, stdout: "", stderr: "Unsupported Host SDK operation" }, "The installed helper did not refuse the unsupported legacy exit operation");
  assert.deepEqual(await readdir(probe), ["owner.json"], "Unsupported installed exit operation wrote fixture evidence");
}

async function readManagedIdentity(root: string) {
  const active: { readonly revision: string } = await Bun.file(join(root, "active.json")).json();
  const status: { readonly updating: boolean; readonly error: string | null; readonly upstreamRevision: string } =
    await Bun.file(join(root, "status.json")).json();
  assert.match(active.revision, /^[a-f0-9]{40,64}$/, "Invalid prepared revision");
  assert.equal(status.updating, false, "Managed postinstall has not finished");
  assert.equal(status.error, null, "Managed postinstall reported an error");
  assert.equal(status.upstreamRevision, active.revision, "Managed postinstall did not activate the prepared revision");
  const directory = await ownedDirectory(join(root, "revisions", active.revision, "package"));
  assert(directory && (directory.mode & 0o222n) === 0n, "Managed package is not a frozen owned directory");
  return { dev: directory.dev, ino: directory.ino };
}

type DirectoryIdentity = { readonly dev: bigint; readonly ino: bigint };

function sameDirectory(a: DirectoryIdentity, b: DirectoryIdentity) {
  return a.dev === b.dev && a.ino === b.ino;
}

async function ownedDirectory(path: string) {
  try {
    const stat = await lstat(path, { bigint: true });
    const uid = process.getuid?.();
    assert(uid !== undefined && stat.uid === BigInt(uid) && stat.isDirectory(), `Not a fixture-owned directory: ${path}`);
    const { dev, ino, mode } = stat;
    return { dev, ino, mode };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function unlockDirectories(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const { uid, mode } = await directory.stat();
    assert.equal(uid, process.getuid?.(), `Not a fixture-owned directory: ${path}`);
    if ((mode & 0o700) !== 0o700) await directory.chmod(0o700);
    for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory()) await unlockDirectories(join(path, entry.name));
  } finally { await directory.close(); }
}

/** npm may retain read-only subtrees on its best-effort retirement cleanup. */
export async function unlockManagedForRemoval(installed: Awaited<ReturnType<typeof installArtifact>>, predecessor: DirectoryIdentity) {
  const nodeModules = dirname(installed.destination);
  assert(await ownedDirectory(nodeModules));
  const current = await ownedDirectory(installed.destination);
  assert(current && sameDirectory(current, installed.directory), "Installed fixture package identity changed before teardown");
  const packages = [installed.destination];
  // Arborist retires into a hidden sibling. Match the captured inode rather
  // than treating any hidden npm directory as the predecessor.
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".")) continue;
    const path = join(nodeModules, entry.name);
    const directory = await ownedDirectory(path);
    if (directory && sameDirectory(directory, predecessor)) packages.push(path);
  }
  for (const path of packages) {
    const managed = join(path, managedRoot);
    if (await ownedDirectory(dirname(managed)) && await ownedDirectory(managed)) await unlockDirectories(managed);
  }
}

export function privateJson(path: string, value: unknown) {
  return writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
