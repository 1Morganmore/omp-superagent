import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addWorker, workerHash } from "../src/worker/worker-registration";
import { workerRepositoryHead } from "../src/worker/worker-repository";
import type { WorkerDescription } from "../src/worker/worker-wire";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const destination = "worker@fixture.example.invalid";
const worker: WorkerDescription = {
  workerId: "worker-verified", platform: "linux", stateDir: "/worker/private",
  repos: [{ id: "a".repeat(64), cwd: "/worker/checkout" }], capacity: 2, active: 0,
};

function fixture() {
  const root = mkdtempSync(join(realpathSync("/tmp"), "wd-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const config = join(root, "config.local.json");
  const bin = join(root, "bin");
  const callsFile = join(root, "calls.jsonl");
  const sshStarted = join(root, "ssh-started");
  mkdirSync(bin);
  writeFileSync(config, JSON.stringify({
    stateDir: "state", headCwd: join(root, "unmounted"), command: ["omp"], maxHosts: 2, maxSubagents: 2, idleMs: 0,
    telegram: { tokenEnv: "UNUSED_FIXTURE_TOKEN", ownerId: "123", allowedChatIds: [] },
  }));
  writeFileSync(join(bin, "ssh"), `#!/bin/sh
: > "$SSH_STARTED"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -eq 3 ] && [ "$2" = "$DESTINATION" ] && [ "$3" = "omp-sa-worker-v1" ] || exit 1
IFS= read -r request || exit 1
printf '%s\\n' "$request" >> "$CALLS"
case "$request" in
  *'"workspace":'*) printf '%s\\n' "$SCOPED_REPLY" ;;
  *) printf '%s\\n' "$REPLY" ;;
esac
`, { mode: 0o700 });
  async function cli(args: readonly string[], description = worker, scopedReply: object = { ok: true, value: description }) {
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/cli.ts"), "worker", ...args], {
      cwd: root, env: { HOME: root, PATH: bin, DESTINATION: destination, CALLS: callsFile, SSH_STARTED: sshStarted,
        REPLY: JSON.stringify({ ok: true, value: description }), SCOPED_REPLY: JSON.stringify(scopedReply) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trimEnd().split("\n").map(line => JSON.parse(line)) : [];
    return { code, stdout, stderr, calls, contacted: existsSync(sshStarted) };
  }
  return { root, stateDir, config, cli, options: { stateDir, destination } };
}

async function enroll(options: Parameters<typeof addWorker>[0], description = worker) {
  const describe = async () => description;
  await addWorker(options, describe);
  await addWorker(options, describe);
}

function git(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["/usr/bin/git", ...args], { cwd,
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function defaultCheckout(root: string) {
  const checkout = join(root, "pinned");
  mkdirSync(checkout);
  git(checkout, ["init", "--quiet"]);
  git(checkout, ["config", "remote.origin.url", "https://github.com/example/worker-fixture.git"]);
  git(checkout, ["-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false",
    "commit", "--quiet", "--allow-empty", "-m", "Fixture"]);
  const source = await workerRepositoryHead(checkout);
  if (!source) throw new Error("Could not build a clean default checkout fixture");
  return { ...source, description: { ...worker, repos: [{ id: source.repoId, cwd: "/worker/checkout" }] } };
}

test.each([true, false])("worker list is offline even without a head checkout (enrolled key present: %s)", async keyPresent => {
  const { cli, stateDir, options } = fixture();
  await enroll(options, { ...worker, active: 1 });
  await addWorker({ stateDir, destination: "worker@pending.example.invalid" }, async () => worker);
  if (!keyPresent) unlinkSync(join(stateDir, "workers", `${workerHash(destination)}.key`));

  const result = await cli(["list"]);

  if (result.code !== 0) throw new Error(result.stderr);
  const { active: _stale, ...verified } = worker;
  expect(JSON.parse(result.stdout)).toEqual({ source: "verified-inventory", workers: [{ destination, ...verified, default: false }] });
  expect(result.contacted).toBe(false);
});

test.each([false, true])("worker doctor does not contact a pending or keyless endpoint (verified: %s)", async verified => {
  const { cli, stateDir, options, config } = fixture();
  if (verified) {
    await enroll(options);
    unlinkSync(join(stateDir, "workers", `${workerHash(destination)}.key`));
  } else {
    await addWorker(options, async () => worker);
  }

  const result = await cli(["doctor", destination, "--config", config]);

  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "blocked", reason: verified ? "identity-unavailable" : "unregistered" });
  expect(result.calls).toEqual([]);
});

test("worker doctor does not send a default checkout revision to an endpoint with enrollment drift", async () => {
  const { cli, root, options } = fixture();
  const source = await defaultCheckout(root);
  await enroll({ ...options, defaultRepositoryRoot: source.root }, source.description);

  const result = await cli(["doctor", destination], { ...source.description, workerId: "replacement", capacity: 101 });

  expect(result.code).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ status: "blocked", check: "worker", reason: "enrollment-mismatch",
    worker: { workerId: source.description.workerId, capacity: source.description.capacity } });
  expect(report).not.toHaveProperty("live");
  expect(result.calls).toEqual([{ version: 1, op: "describe" }]);
});

test("worker doctor does not disclose a revision from a default checkout whose Git identity changed", async () => {
  const { cli, root, options } = fixture();
  const source = await defaultCheckout(root);
  await enroll({ ...options, defaultRepositoryRoot: source.root }, source.description);
  git(source.root, ["config", "remote.origin.url", "https://github.com/example/not-enrolled.git"]);

  const result = await cli(["doctor", destination], source.description);

  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "blocked", check: "default-workspace", reason: "local-checkout-unverified" });
  expect(result.calls).toEqual([{ version: 1, op: "describe" }]);
});

test("worker doctor reports a default revision refusal without rewriting enrollment or relaying peer diagnostics", async () => {
  const { cli, root, stateDir, options } = fixture();
  const { root: pinned, description, ...workspace } = await defaultCheckout(root);
  await enroll({ ...options, defaultRepositoryRoot: pinned }, description);
  const inventory = join(stateDir, "workers", "verified.json");
  const before = readFileSync(inventory, "utf8");
  const peerMessage = "private remote diagnostic";

  const result = await cli(["doctor", destination], { ...description, active: 1 }, { ok: false, error: peerMessage });

  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "blocked", reason: "describe-unverified", check: "default-workspace",
    live: { active: 1, available: 1 }, workspace });
  expect(`${result.stdout}${result.stderr}`).not.toContain(peerMessage);
  expect(result.calls).toEqual([{ version: 1, op: "describe" }, { version: 1, op: "describe", workspace }]);
  expect(readFileSync(inventory, "utf8")).toBe(before);
});
