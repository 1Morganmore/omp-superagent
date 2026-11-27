import { expect, test } from "bun:test";
import { once } from "node:events";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/upgrade-evidence.mjs", import.meta.url));
const laneId = "lane-fixture";
const sessionId = "fixture-session";
const machine = { hostname: hostname(), platform: process.platform, uid: process.getuid?.() };

function probe(...args: readonly string[]) {
  return Bun.$`${process.execPath} --no-env-file ${script} ${[...args]}`.quiet().nothrow();
}

function privateJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function fileIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

type WireBehavior = "normal" | "changed_chunk" | "incomplete_state" | "refuse_v2" | "new_session" | "lost_ack" | "wrong_ack";

// The Unix listener exercises the real probe's shipped protocol and shutdown boundary.
async function laneFixture(options: {
  readonly behavior?: WireBehavior; readonly placement?: "local" | "worker" | "head"; readonly linked?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "sa-probe-"));
  const run = join(root, "run");
  mkdirSync(run, { mode: 0o700 });
  const id = options.placement === "head" ? "main" : laneId;
  const worker = options.placement === "worker";
  const socketPath = join(run, `${id}.sock`);
  const main = { socketPath: join(run, "main.sock") };
  const sessionFile = join(root, "session.jsonl");
  const captureFile = join(root, "capture.json");
  const statusFile = join(root, "status.json");
  const referent = options.linked ? join(root, "native.jsonl") : sessionFile;
  writeFileSync(referent, "", { mode: 0o644 });
  if (options.linked) symlinkSync(referent, sessionFile);
  const native = Bun.spawn([process.execPath, "-e", "for await (const _ of Bun.stdin.stream()) {}"],
    { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  const state = { hostPid: native.pid, adapterOwnerPid: process.pid, sessionId, sessionFile,
    ...(worker ? { workerAttempt: "attempt" } : {}) };
  const behavior = options.behavior ?? "normal";
  const connections: string[][] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    const commands: string[] = [];
    connections.push(commands);
    const currentSession = behavior === "new_session" && connections.length > 1 ? "other" : sessionId;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const onPeerDisconnect = (error: Error) => {
      if (!("code" in error) || (error.code !== "ECONNRESET" && error.code !== "EPIPE")) throw error;
    };
    socket.on("error", onPeerDisconnect);
    const lines = createInterface({ input: socket });
    // readline re-emits socket errors when the probe rejects a chunk before the remaining writes drain.
    lines.on("error", onPeerDisconnect);
    const send = (frame: object) => socket.write(JSON.stringify(frame) + "\n");
    send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2],
      ...(worker ? { workerIdentity: state } : {}) });
    let negotiated = false;
    lines.on("line", line => {
      const { id, type, protocolVersion }: { id: string; type: string; protocolVersion?: number } = JSON.parse(line);
      commands.push(type);
      const reply = (data: object, success = true) => ({ type: "response", command: type, id, success, data });
      if (type === "negotiate_protocol") {
        negotiated = protocolVersion === 2 && behavior !== "refuse_v2";
        send(reply({ protocolVersion: negotiated ? 2 : 1 }, negotiated));
      } else if (type === "get_state") {
        if (!negotiated) {
          send(reply({}, false)); // The same state cannot fit in its v1 response.
          return;
        }
        const data = { adapterProtocol: "owned-stock-stdio-v1", ...state, sessionId: currentSession,
          systemPrompt: "p".repeat(1024 * 1024) };
        const encoded = Buffer.from(JSON.stringify(reply(data)));
        const size = 256 * 1024;
        const count = Math.ceil(encoded.length / size);
        for (let index = 0; index < count; index++) {
          send({ type: "rpc_chunk", chunkId: behavior === "changed_chunk" && index === 1 ? "other" : id,
            index, count, byteLength: encoded.length,
            data: encoded.subarray(index * size, (index + 1) * size).toString("base64") });
          if (behavior === "incomplete_state") {
            socket.end();
            break;
          }
        }
      } else if (type === "shutdown_host") {
        if (behavior !== "lost_ack") {
          send(reply({ shutdown: true, sessionId: behavior === "wrong_ack" ? "other" : sessionId, sessionFile }));
        }
        socket.end();
      }
    });
  });
  const listening = once(server, "listening");
  server.listen(socketPath);
  await listening;
  chmodSync(socketPath, 0o600);
  const row = { id, socketPath, sessionId, placement: { target: "local" } };
  privateJson(statusFile, { main, lanes: [row], note: "status may include a large inventory ".repeat(512) });
  return {
    captureFile, connections, main, row, referent, root, sessionFile, socketPath, statusFile,
    capture: () => probe("capture", "host", socketPath, sessionId, ...(worker ? ["--worker"] : [])),
    async close() {
      for (const socket of sockets) socket.destroy();
      const closed = once(server, "close");
      server.close();
      native.stdin.end();
      await Promise.all([closed, native.exited]);
      rmSync(root, { force: true, recursive: true });
    },
  };
}

test.each([["normal", 0], ["lost_ack", 1], ["wrong_ack", 1]] as const)(
  "local stop verifies chunked ownership then sends one shutdown on that connection (%s)", async (behavior, exit) => {
    const lane = await laneFixture({ behavior, linked: true });
    try {
      const captured = await lane.capture();
      expect(captured.exitCode).toBe(0);
      expect(captured.text()).not.toContain("systemPrompt");
      writeFileSync(lane.captureFile, captured.stdout, { mode: 0o600 });

      const stopped = await probe("stop-local", lane.captureFile, lane.statusFile, laneId);

      expect(stopped.exitCode).toBe(exit);
      if (exit === 0) expect(stopped.json()).toEqual({ result: "shutdown-accepted" });
      else expect(stopped.stdout.length).toBe(0);
      expect(lane.connections).toEqual([
        ["negotiate_protocol", "get_state"],
        ["negotiate_protocol", "get_state", "shutdown_host"],
      ]);
    } finally {
      await lane.close();
    }
  },
);

test.each([
  ["wrong managing instance", "moved"],
  ["remote placement", "remote"],
  ["a worker capture", "worker"],
  ["a HEAD selection", "main"],
  ["a non-exact lane ID", "prefix"],
  ["a different captured machine", "machine"],
  ["a different live session", "session"],
  ["a changed journal referent", "journal"],
] as const)("local stop does not send shutdown for %s", async (_label, cause) => {
  const lane = await laneFixture({ linked: cause !== "worker",
    placement: cause === "worker" ? "worker" : cause === "main" ? "head" : "local",
    behavior: cause === "session" ? "new_session" : "normal" });
  try {
    const captured = await lane.capture();
    expect(captured.exitCode).toBe(0);
    const capture: { machine: { hostname: string } } = captured.json();
    if (cause === "machine") capture.machine.hostname += "-different";
    privateJson(lane.captureFile, capture);
    const main = cause === "moved" ? { socketPath: join(lane.root, "elsewhere", "run", "main.sock") } : lane.main;
    const row = cause === "remote" ? { ...lane.row, placement: { target: "remote", workerId: "fixture" } } : lane.row;
    privateJson(lane.statusFile, { main, lanes: [row] });
    if (cause === "journal") {
      const replacement = `${lane.referent}.new`;
      writeFileSync(replacement, "", { mode: 0o600 });
      renameSync(replacement, lane.referent);
    }
    const requestedId = cause === "main" ? "main" : cause === "prefix" ? "lane-fixtur" : laneId;

    const stopped = await probe("stop-local", lane.captureFile, lane.statusFile, requestedId);

    expect(stopped.exitCode).toBe(1);
    const identityProbe = ["negotiate_protocol", "get_state"];
    expect(lane.connections).toEqual(cause === "journal" || cause === "session" ? [identityProbe, identityProbe] : [identityProbe]);
  } finally {
    await lane.close();
  }
});

test.each([
  ["incomplete_state", "local", false, ["negotiate_protocol", "get_state"]],
  ["changed_chunk", "local", false, ["negotiate_protocol", "get_state"]],
  ["refuse_v2", "local", false, ["negotiate_protocol"]],
  ["normal", "worker", true, ["negotiate_protocol", "get_state"]],
] as const)("capture fails closed for %s (placement=%s, linked=%s)", async (behavior, placement, linked, commands) => {
  const lane = await laneFixture({ behavior, placement, linked });
  try {
    const captured = await lane.capture();

    expect(captured.exitCode).toBe(1);
    expect(captured.stdout.length).toBe(0);
    if (behavior === "changed_chunk") expect(captured.stderr.toString().trim()).toBe("Host chunk sequence mismatch");
    expect(lane.connections).toEqual([[...commands]]);
  } finally {
    await lane.close();
  }
});

test("recheck confirms an unchanged local journal link without requesting shutdown", async () => {
  const lane = await laneFixture({ linked: true });
  try {
    const captured = await lane.capture();
    expect(captured.exitCode).toBe(0);
    writeFileSync(lane.captureFile, captured.stdout, { mode: 0o600 });

    const rechecked = await probe("recheck", lane.captureFile);

    expect(rechecked.exitCode).toBe(0);
    expect(rechecked.json()).toMatchObject({ result: "identity-unchanged" });
    expect(lane.connections).toEqual(Array.from({ length: 2 }, () => ["negotiate_protocol", "get_state"]));
  } finally {
    await lane.close();
  }
});

test.each([
  ["rejects an unchanged receipt even if all identity fields match", false, "ours", false, false, 1],
  ["rejects a new receipt for a different worker attempt", true, "different", false, false, 1],
  ["accepts a new receipt for the captured worker attempt", true, "ours", false, false, 0],
  ["accepts a local journal link to its original file", true, undefined, true, false, 0],
  ["rejects a replacement local journal despite a matching fresh receipt", true, undefined, true, true, 1],
] as const)("operator exit verification %s", async (_label, fresh, workerAttempt, linked, replaced, exit) => {
  const root = mkdtempSync(join(tmpdir(), "omp-sa-evidence-"));
  const spawn = () => Bun.spawn([process.execPath, "--version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const native = spawn();
  const owner = spawn();
  try {
    await Promise.all([native.exited, owner.exited]);
    const socketPath = join(root, "lane.sock");
    const sessionFile = join(root, "session.jsonl");
    const captureFile = join(root, "capture.json");
    const receiptPath = `${socketPath}.exit.json`;
    const identity = { pid: native.pid, ownerPid: owner.pid, sessionId: "worker-session", sessionFile };
    const receipt = { ...identity, workerAttempt: linked ? undefined : "ours", code: 0, signal: null,
      persisted: true, observationsFlushed: true };
    const referent = linked ? join(root, "native.jsonl") : sessionFile;
    writeFileSync(referent, "", { mode: 0o600 });
    if (linked) symlinkSync(referent, sessionFile);
    privateJson(receiptPath, receipt);
    privateJson(captureFile, {
      machine,
      endpoint: {
        kind: "host", socketPath, ...identity, workerAttempt: receipt.workerAttempt,
        journal: { resolvedPath: realpathSync(referent), ...fileIdentity(referent),
          ...(linked ? { link: fileIdentity(sessionFile) } : {}) },
        priorReceipt: fileIdentity(receiptPath),
      },
    });
    if (fresh) {
      const temporary = `${receiptPath}.tmp`;
      privateJson(temporary, { ...receipt, workerAttempt });
      renameSync(temporary, receiptPath);
    }
    if (replaced) {
      const replacement = `${referent}.new`;
      writeFileSync(replacement, "", { mode: 0o600 });
      renameSync(replacement, referent);
    }

    const verified = await probe("verify", captureFile);

    expect(verified.exitCode).toBe(exit);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
