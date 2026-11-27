/** Private subprocess harness for the native daemon and isolated stock OMP. */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Inbound } from "../../src/contracts";
import { gatewayCall } from "../../src/gateway/gateway-protocol";
import type { GatewayStatus } from "../../src/gateway/gateway-wire";
import { assertResidentFixtureOwner, stopHostFixtures, waitForFixtureProcessExit } from "./host-fixture-processes";
import { isolatedNativeEnvironment, within } from "./native-subprocess";

export type Head = { readonly pid: number; readonly ownerPid: number; readonly sessionId: string;
  readonly sessionFile: string; readonly dev: number; readonly ino: number };
type Instance = { readonly head: Head; readonly gatewayPid: number };
type ModelObservation = {
  readonly head: Head;
  readonly model: { readonly provider: string; readonly id: string } | null;
  readonly configuredDefault?: string;
  readonly configuredThinkingLevel?: string | null;
  readonly modelSettings: unknown;
  readonly thinkingLevel: { readonly present: boolean; readonly value?: string | null };
};
const packageRoot = resolve(import.meta.dir, "../..");

export async function until<T>(check: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const deadline = performance.now() + 55_000;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    assert(performance.now() < deadline, `Native Rust Gateway did not reach ${label}`);
    await Bun.sleep(25);
  }
}

export function gatewayFixture(root: string, profile: "debug" | "release" = "debug") {
  const runDir = join(root, "run");
  const config = join(root, "superagent.json");
  const sessionFile = join(root, "sessions", "main", "session.jsonl");
  const gatewaySocket = join(runDir, "gateway.sock");
  const hostSocket = join(runDir, "main.sock");
  const env = {
    ...isolatedNativeEnvironment(root),
    OMP_TEST_HOST_FIXTURE_ROOT: root, OMP_NATIVE_GATEWAY_ROOT: root, OMP_NATIVE_GATEWAY_PRESETS: "valid",
    OMP_SUPERAGENT_ROOT: packageRoot, OMP_SUPERAGENT_BUN: process.execPath,
    OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH: join(import.meta.dir, "managed-super"),
    ...(process.env.OMP_TEST_COMMAND === undefined ? {} : { OMP_TEST_COMMAND: process.env.OMP_TEST_COMMAND }),
    ...(process.env.OMP_TEST_NATIVES_DIR ? { OMP_TEST_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR,
      PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
  };
  const targetDir = resolve(packageRoot, process.env.CARGO_TARGET_DIR ?? "gateway/target");
  const example = join(targetDir, profile, "examples", "gateway-lifecycle-fixture");
  const bun = [process.execPath, "--no-env-file", "--no-install"];
  const launch = (agentDir = env.PI_CODING_AGENT_DIR, dataHome = env.XDG_DATA_HOME) => Bun.spawn([example, config], { cwd: root,
    env: { ...env, PI_CODING_AGENT_DIR: agentDir, XDG_DATA_HOME: dataHome, ISOLATED_GATEWAY_DISCORD_TOKEN: "offline-fixture-only" },
    stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  let gateway: ReturnType<typeof launch> | undefined;
  let logs: Promise<string> | undefined;

  const run = async (cmd: readonly string[], expected = 0) => {
    const child = Bun.spawn([...cmd], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      const [stdout, stderr, exit] = await within(Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]), 40_000, `Command timed out: ${cmd.slice(-3).join(" ")}`);
      assert.equal(exit, expected, `${stdout}${stderr}`);
      return { stdout, stderr };
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  };
  const sdk = (...args: string[]) => run([...bun, join(import.meta.dir, "native-rust-gateway-sdk.ts"), ...args]);
  const cli = (command: "status" | "stop", expected = 0) =>
    run([...bun, join(packageRoot, "src", "cli.ts"), command, "--config", config], expected);
  const status = () => gatewayCall<GatewayStatus>(gatewaySocket, "/status", undefined, { timeoutMs: 2_000 });
  const cliStatus = async (): Promise<GatewayStatus | null> =>
    (JSON.parse((await cli("status")).stdout) as { gateway: GatewayStatus | null }).gateway;
  const snapshot = async (phase: "streaming" | "settled"): Promise<Head> =>
    JSON.parse((await sdk("snapshot", phase)).stdout);
  const observeModel = async (): Promise<ModelObservation> =>
    JSON.parse((await sdk("snapshot", "settled", "model")).stdout);
  const releaseBusy = () => writeFile(join(root, "release-207"), "", { mode: 0o600 });
  const detached = async () => (await readdir(root)).sort().flatMap(name => {
    const match = /^gateway-fixture-(runner|successor)\.(\d+)$/.exec(name);
    return match ? [{ role: match[1], pid: Number(match[2]) }] : [];
  });

  async function ready(gatewayPid: number, observe?: (status: GatewayStatus) => void): Promise<Instance> {
    await until(async () => {
      if (gateway?.pid === gatewayPid) assert.equal(gateway.exitCode, null, "Native daemon exited during startup");
      const socket = statSync(gatewaySocket, { throwIfNoEntry: false });
      if (!socket?.isSocket() || (socket.mode & 0o777) !== 0o600) return;
      // SIGKILL leaves the predecessor's 0600 socket in place until the new
      // daemon proves ownership. Only send status to the published listener.
      const db = new Database(join(root, "coordination.sqlite"), { readonly: true });
      try {
        db.run("PRAGMA busy_timeout = 5000");
        const owner = db.query<{ pid: number; dev: number; ino: number }, []>(
          `SELECT json_extract(value,'$.pid') AS pid, json_extract(value,'$.dev') AS dev,
            json_extract(value,'$.ino') AS ino FROM metadata WHERE key='gateway:socket'`).get();
        if (owner?.pid !== gatewayPid || owner.dev !== socket.dev || owner.ino !== socket.ino) return;
      } finally { db.close(); }
      const current = await status();
      if (current.gateway.pid === gatewayPid) observe?.(current);
      if (current.gateway.pid === gatewayPid && current.head.ready && current.gateway.admissionReady) return current;
    }, "attached, preset-ready HEAD and durable intake readiness");
    const head = await snapshot("settled");
    await assertResidentFixtureOwner(root, { nativePid: head.pid, ownerPid: head.ownerPid });
    const operatorStatus = await cliStatus();
    assert(operatorStatus, "The operator could not see the native fixture daemon");
    assert.equal(operatorStatus.gateway.pid, gatewayPid);
    assert.equal(operatorStatus.gateway.admissionReady, true);
    assert.equal(operatorStatus.head.ready, true);
    assert.equal(operatorStatus.head.pid, head.pid);
    assert.equal(operatorStatus.head.loadedSuperkitPath, env.OMP_SUPERAGENT_TEST_MANAGED_ULW_PATH);
    assert.equal(operatorStatus.head.initialization?.sessionId, head.sessionId);
    assert.equal(head.sessionFile, sessionFile);
    return { head, gatewayPid };
  }

  function launchGateway(agentDir?: string, dataHome?: string): number {
    assert(!gateway || gateway.exitCode !== null || gateway.signalCode !== null,
      "Cannot replace the fixture's live Gateway");
    const child = gateway = launch(agentDir, dataHome);
    logs = new Response(child.stderr).text();
    return child.pid;
  }

  function start(observe?: (status: GatewayStatus) => void): Promise<Instance> {
    return ready(launchGateway(), observe);
  }

  async function crashGateway(gatewayPid: number): Promise<void> {
    const child = gateway;
    assert(child?.pid === gatewayPid && child.exitCode === null && child.signalCode === null,
      "Crash injection requires the live Gateway subprocess started by this fixture");
    child.kill("SIGKILL");
    await within(child.exited, 5_000, "Interrupted fixture Gateway did not exit");
    assert.equal(child.signalCode, "SIGKILL");
  }

  async function initialExit(): Promise<void> {
    const child = gateway;
    assert(child);
    assert.equal(await within(child.exited, 40_000, "Initial native daemon did not exit"), 0, (await logs) ?? "");
  }

  async function headExit(head: Head): Promise<void> {
    await waitForFixtureProcessExit([head.pid, head.ownerPid]);
    assert.deepEqual(JSON.parse(await readFile(`${hostSocket}.exit.json`, "utf8")), {
      pid: head.pid, ownerPid: head.ownerPid, sessionId: head.sessionId, sessionFile,
      code: 0, signal: null, persisted: true, observationsFlushed: true,
    });
  }

  async function stop({ head, gatewayPid }: Instance): Promise<void> {
    assert.equal((await cliStatus())?.gateway.pid, gatewayPid, "Operator stop must target the exact fixture Gateway");
    await cli("stop");
    if (gateway?.pid === gatewayPid) await initialExit();
    else await waitForFixtureProcessExit([gatewayPid]);
    await headExit(head);
    assert.equal(await cliStatus(), null);
    assert.equal(existsSync(hostSocket), false);
  }

  async function stageInput(input: Inbound): Promise<string> {
    const temporary = join(root, "staged-input");
    const inbox = join(root, "adapter-inbox.json");
    await writeFile(temporary, JSON.stringify(input), { mode: 0o600, flag: "wx" });
    await rename(temporary, inbox);
    return inbox;
  }

  async function deliver(input: Inbound): Promise<void> {
    const inbox = await stageInput(input);
    await until(() => !existsSync(inbox) || undefined, `adapter consumption of ${input.id}`);
  }

  async function cleanup(succeeded: boolean): Promise<void> {
    try {
      await writeFile(join(root, "stop-test-gateways"), "", { mode: 0o600 });
      await releaseBusy();
      if (gateway?.exitCode === null && gateway.signalCode === null) {
        const child = gateway;
        try { await within(child.exited, 5_000, "Owned native daemon did not observe the cleanup marker"); }
        catch {
          child.kill("SIGKILL"); // Only the exact example child started by Bun.
          await within(child.exited, 5_000, "Owned daemon did not exit after SIGKILL");
        }
      }
      await waitForFixtureProcessExit((await detached()).map(child => child.pid));
      const diagnostics = await logs;
      if (!succeeded && diagnostics) console.error(diagnostics);
    } finally { await stopHostFixtures(root, runDir); }
  }

  return { root, home: env.HOME, config, sessionFile, run, sdk, cli, cliStatus, status, snapshot, observeModel, releaseBusy,
    ready, start, launchGateway, crashGateway, initialExit, headExit, stop, stageInput, deliver, detached, cleanup };
}
