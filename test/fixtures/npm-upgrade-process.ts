import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// The daemon can outlive the 45 s launcher's wait. Its own config, memory
// checks and stock CLI probes are still bounded before socket publication.
const unpublishedGatewayTimeout = 120_000;

export async function checked([command, ...args]: [string, ...string[]], options: {
  readonly cwd: string; readonly env: Record<string, string>; readonly timeout?: number;
}) {
  // Leave terminal SIGINT with the fixture so it can reconcile in-flight
  // mutating commands. Keep the pipes and await close, not just CLI exit:
  // the native launcher's inherited stderr closes when it finishes too.
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"],
    detached: true, timeout: options.timeout ?? 35_000, killSignal: "SIGKILL" });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const [code, signal] = await new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  assert.equal(code, 0, `${[command, ...args].join(" ")} (signal: ${signal})\n${stdout}${stderr}`);
  return stdout.trim();
}

export async function until<T>(detail: string, timeout: number, sample: () => Promise<T | undefined> | T | undefined,
  signal?: AbortSignal): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    signal?.throwIfAborted();
    const result = await sample();
    signal?.throwIfAborted();
    if (result !== undefined) return result;
    const remaining = deadline - performance.now();
    assert(remaining > 0, `Timed out waiting for ${detail}`);
    await delay(Math.min(150, remaining), undefined, { signal });
  }
}

export function alive(pid: number): boolean {
  assert(Number.isInteger(pid) && pid > 1, "Invalid fixture process ID");
  try { return process.kill(pid, 0); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export async function privateGatewaySocket(path: string) {
  try {
    const endpoint = await lstat(path);
    const parent = dirname(path);
    const directory = await lstat(parent);
    assert(await realpath(parent) === parent && directory.isDirectory() &&
      directory.uid === process.getuid?.() && (directory.mode & 0o777) === 0o700,
    "Gateway socket directory is not the fixture's private directory");
    assert(endpoint.isSocket() && endpoint.uid === directory.uid && (endpoint.mode & 0o777) === 0o600,
      "Gateway endpoint is not a private owned socket");
    return { dev: endpoint.dev, ino: endpoint.ino };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export type GatewaySocket = NonNullable<Awaited<ReturnType<typeof privateGatewaySocket>>>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function stopPrivateGateway(options: {
  readonly gateway: string; readonly host: string; readonly launch: Promise<string>;
  readonly owner?: { readonly gatewayPid: number; readonly socket: GatewaySocket; readonly hostPids: readonly number[] };
}) {
  const { gateway, host, launch, owner } = options;
  // Startup failure can leave the detached Gateway finishing preflight and
  // adapter startup before publishing its socket. Resolve the in-flight
  // launcher first, then look only in this fixture's private state directory.
  const endpoint = await launch.then(
    () => privateGatewaySocket(gateway),
    () => until("private Gateway socket after unconfirmed launch", unpublishedGatewayTimeout, () => privateGatewaySocket(gateway)),
  );
  assert(endpoint, "Private Gateway socket disappeared after launch");
  let pid: number;
  if (owner) {
    // An already observed socket and PID identify this fixture's Gateway.
    assert.deepEqual(endpoint, owner.socket, "Private Gateway identity changed before cleanup");
    pid = owner.gatewayPid;
  } else {
    const response = await fetch("http://localhost/status", { unix: gateway, redirect: "error", signal: AbortSignal.timeout(5_000) });
    const report = await response.json();
    assert(response.ok && object(report) && report.ok === true && object(report.value) &&
      object(report.value.gateway) && typeof report.value.gateway.pid === "number", "Private Gateway did not return its cleanup PID");
    pid = report.value.gateway.pid;
  }
  assert(alive(pid), "The private Gateway cleanup PID is not live");
  assert.deepEqual(await privateGatewaySocket(gateway), endpoint, "Private Gateway socket changed before cleanup");
  const stopped = await fetch("http://localhost/stop", { unix: gateway, method: "POST", body: "{}",
    headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(25_000) });
  const result = await stopped.json();
  assert(stopped.ok && object(result) && result.ok === true, "Private Gateway refused failure cleanup");
  const pids = [pid, ...(owner?.hostPids ?? [])];
  await until("private Gateway socket removal and process exit", 20_000, () =>
    !existsSync(gateway) && !existsSync(host) && pids.every(pid => !alive(pid)) ? true : undefined);
}
