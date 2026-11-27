/** Package CI regression: stop the private predecessor before replacing it and resume its HEAD. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { installArtifact, prepareArtifacts, privateJson, unlockManagedForRemoval, verifyInstalledExitRefusal } from "./npm-upgrade-assets";
import { checked } from "./npm-upgrade-process";
import { upgradeRuntime } from "./npm-upgrade-runtime";

const [candidate, platform, cache, ...extra] = process.argv.slice(2);
assert(candidate && platform && !extra.length,
  "Usage: bun --no-env-file test/fixtures/npm-upgrade.ts CANDIDATE_TGZ PLATFORM [ARTIFACT_CACHE]");
const artifactCache = cache ? await realpath(cache) : undefined;
if (artifactCache) {
  const directory = await lstat(artifactCache);
  assert(directory.isDirectory() && directory.uid === process.getuid?.() && (directory.mode & 0o077) === 0,
    "ARTIFACT_CACHE must be a private owned directory");
}
const root = await mkdtemp(join(await realpath("/tmp"), "sa-npm-upgrade-"));
const prefix = join(root, "install");
const omp = join(root, "omp");
const npmCache = join(artifactCache ?? root, "npm-cache");
const env = {
  PATH: [dirname(process.execPath), process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
  HOME: join(root, "home"), USERPROFILE: join(root, "home"),
  PI_CODING_AGENT_DIR: join(root, "agent"), PI_NO_TITLE: "1",
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "xdg-state"),
  CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), COPILOT_HOME: join(root, "copilot"),
  OMP_DAEMON_DIR: join(root, "daemon"), TMPDIR: root, TMP: root, TEMP: root,
  NPM_CONFIG_USERCONFIG: join(root, "home", "user.npmrc"),
  NPM_CONFIG_GLOBALCONFIG: join(root, "home", "global.npmrc"),
  NPM_CONFIG_CACHE: npmCache, NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  CI: "true", NO_COLOR: "1",
};
const install = { prefix, platform, env };
const interruption = new AbortController();
const { signal } = interruption;
const interrupt = (name: NodeJS.Signals, code: number) => {
  if (signal.aborted) return;
  process.exitCode = code;
  interruption.abort(new Error(`Private npm upgrade interrupted by ${name}`));
};
const onInterrupt = () => interrupt("SIGINT", 130);
const onTerminate = () => interrupt("SIGTERM", 143);
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
let runtime: ReturnType<typeof upgradeRuntime> | undefined;
let phase = "staging release artifacts";
console.error(`Private npm upgrade fixture: ${root}`);
try {
  for (const path of [prefix, env.HOME, env.PI_CODING_AGENT_DIR, join(root, "work")]) await mkdir(path, { mode: 0o700 });
  await mkdir(npmCache, { recursive: true, mode: 0o700 });
  const npmCacheDirectory = await lstat(npmCache);
  assert(npmCacheDirectory.isDirectory() && npmCacheDirectory.uid === process.getuid?.() &&
    (npmCacheDirectory.mode & 0o077) === 0, "npm cache must be a private owned directory");
  await privateJson(join(prefix, "package.json"), { private: true });
  const artifacts = await prepareArtifacts({ root, candidate: resolve(candidate), platform, cache: artifactCache });
  signal.throwIfAborted();

  phase = "installing and starting the published package";
  const oldPackage = await installArtifact(artifacts.old, install);
  signal.throwIfAborted();
  await symlink(artifacts.old.omp, omp);
  // Resolve the bundled catalogue through the installed predecessor, never through the checkout.
  const disabledProviders: string[] = JSON.parse(await checked([
    process.execPath, "--no-env-file", "-e",
    'import { getBundledProviders } from "@oh-my-pi/pi-catalog/models"; console.log(JSON.stringify(getBundledProviders()));',
  ], { cwd: oldPackage.destination, env }));
  signal.throwIfAborted();
  runtime = upgradeRuntime({ root, env, command: oldPackage.command, signal });
  await runtime.configure(omp, [...new Set([...disabledProviders, "ollama", "lm-studio", "llama.cpp", "apple"])]);
  const originalConfig = await readFile(runtime.config);
  const old = await runtime.ready();
  const observation = await runtime.turn("old", old.head);
  const inode = await runtime.physicalJournal();
  assert(!existsSync(runtime.receiptPath), "Unexpected prior exit receipt in this private fixture");

  phase = "stopping and verifying the intact predecessor before package replacement";
  await runtime.stop(old, "old");
  assert.equal(await runtime.status(), null);
  assert.deepEqual(await runtime.physicalJournal(), inode);
  assert.deepEqual((await runtime.entries()).find(entry => entry.id === observation.id), observation);

  phase = "installing the actual candidate tarball after verified shutdown";
  // Leave the stopped predecessor untouched; npm owns replacement and retirement.
  signal.throwIfAborted();
  const replacement = await installArtifact(artifacts.candidate, install);
  assert.equal(replacement.destination, oldPackage.destination);
  assert.equal(replacement.command, oldPackage.command);
  assert.notDeepEqual(replacement.managed, oldPackage.managed, "npm did not materialize a new managed installation");
  assert.deepEqual(await runtime.physicalJournal(), inode);
  assert.deepEqual((await runtime.entries()).find(entry => entry.id === observation.id), observation);

  phase = "checking the installed candidate rejects the unsupported legacy helper operation";
  signal.throwIfAborted();
  await verifyInstalledExitRefusal(replacement.destination, { root, env });

  phase = "starting the installed candidate with the original config and physical journal";
  signal.throwIfAborted();
  // Preserve the configured command pathname and config bytes, but select the candidate's matched stock CLI.
  await symlink(artifacts.candidate.omp, `${omp}.next`);
  await rename(`${omp}.next`, omp);
  assert.deepEqual(await readFile(runtime.config), originalConfig);
  const successor = await runtime.ready();
  assert.equal(successor.head.sessionId, old.head.sessionId);
  assert.equal(successor.head.sessionFile, old.head.sessionFile);
  assert.notEqual(successor.head.hostPid, old.head.hostPid);
  assert.notEqual(successor.head.adapterOwnerPid, old.head.adapterOwnerPid);
  assert.notEqual(successor.gatewayPid, old.gatewayPid);
  assert.deepEqual(await runtime.physicalJournal(), inode);
  assert.deepEqual((await runtime.entries()).find(entry => entry.id === observation.id), observation);
  const resumedObservation = await runtime.turn("new", successor.head);

  phase = "verifying the candidate stop and retention of both observations";
  await runtime.stop(successor, "new");
  assert.equal(await runtime.status(), null);
  assert.deepEqual(await runtime.physicalJournal(), inode);
  const retained = await runtime.entries();
  assert.deepEqual(retained.find(entry => entry.id === observation.id), observation);
  assert.deepEqual(retained.find(entry => entry.id === resumedObservation.id), resumedObservation);
  const verifiedRuntime = runtime;
  runtime = undefined;
  await verifiedRuntime.close();
  signal.throwIfAborted();
  phase = "removing the verified private fixture";
  await unlockManagedForRemoval(replacement, oldPackage.directory);
  signal.throwIfAborted();
  await rm(root, { recursive: true });
  console.log(`Verified stop-first npm upgrade ${artifacts.old.version} → ${artifacts.candidate.version} on ${platform}: same HEAD journal, retained observations, clean exits and Kakao intake.`);
} catch (cause) {
  const message = `npm upgrade failed while ${phase}; private fixture retained at ${root}`;
  try { await runtime?.close(); }
  catch (cleanup) { throw new AggregateError([cause, cleanup], message); }
  if (!signal.aborted) throw new Error(message, { cause });
  console.error(cause === signal.reason ? new Error(message, { cause }) : new AggregateError([cause, signal.reason], message));
} finally {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
}
