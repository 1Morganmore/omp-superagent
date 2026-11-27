// Dependency-free operator probe for installations using the 0.1.10+ local wire.
import { request } from "node:http";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { absolute, entry, inode, journal, machine, ownedFile, privateJson, readJson, socket } from "./upgrade-evidence-files.mjs";
import { logicalLimit, probeTimeoutMs, requireEvidence, Unconfirmed, wireLimit, withHost } from "./upgrade-host-wire.mjs";

const usage =
  "Usage: upgrade-evidence.mjs capture gateway SOCKET | capture host SOCKET SESSION_ID [--worker] | recheck CAPTURE.json | stop-local CAPTURE.json STATUS.json LANE_ID | verify CAPTURE.json";

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
}

function text(value) {
  return typeof value === "string" && value.length > 0;
}

function exists(pid) {
  requireEvidence(validPid(pid), "Invalid native PID");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && error.code === "ESRCH") return false;
    throw new Unconfirmed(`Cannot establish whether PID ${pid} exists`);
  }
}

async function gatewayStatus(path) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: path, path: "/status", signal: AbortSignal.timeout(probeTimeoutMs) }, async res => {
      try {
        requireEvidence(res.statusCode === 200, "Old Gateway did not return status");
        const chunks = [];
        let size = 0;
        for await (const chunk of res) {
          size += chunk.length;
          requireEvidence(size <= wireLimit, "Gateway status exceeded size limit");
          chunks.push(chunk);
        }
        const reply = readJson(Buffer.concat(chunks));
        requireEvidence(reply?.ok === true && reply.value?.gateway && reply.value?.head, "Invalid Gateway status");
        resolve(reply.value);
      } catch (error) {
        res.destroy();
        reject(error);
      }
    });
    req.on("error", reject);
    req.end();
  });
}

function hostEvidence({ socketPath, expectedSession, worker }, before, { state, workerIdentity }) {
  const { hostPid: pid, adapterOwnerPid: ownerPid, sessionId, sessionFile, workerAttempt } = state;
  requireEvidence(state.adapterProtocol === "owned-stock-stdio-v1" && pid !== ownerPid &&
    validPid(pid) && validPid(ownerPid) && exists(pid) && exists(ownerPid) &&
    text(sessionId) && sessionId === expectedSession && absolute(sessionFile), "Live Host did not match the expected native session");
  requireEvidence(worker ? text(workerAttempt) && workerIdentity?.hostPid === pid &&
    workerIdentity.adapterOwnerPid === ownerPid && workerIdentity.sessionId === sessionId &&
    workerIdentity.sessionFile === sessionFile && workerIdentity.workerAttempt === workerAttempt
    : workerAttempt === undefined && workerIdentity === undefined, "Host did not match the expected local/worker placement");
  const journalIdentity = journal(sessionFile, worker);
  const receiptPath = `${socketPath}.exit.json`;
  const prior = entry(receiptPath);
  if (prior) ownedFile(prior, receiptPath, 0o077n);
  requireEvidence(isDeepStrictEqual(before, socket(socketPath)), `Host socket changed during capture: ${socketPath}`);
  return { kind: "host", socketPath, socket: before, pid, ownerPid, sessionId, sessionFile, journal: journalIdentity,
    ...(worker ? { workerAttempt } : {}), priorReceipt: prior ? inode(prior) : null };
}

function captureHost(expectation) {
  const before = socket(expectation.socketPath);
  return withHost(expectation.socketPath, live => hostEvidence(expectation, before, live));
}

async function stopLocal(host, status, laneId) {
  requireEvidence(host.kind === "host" && host.workerAttempt === undefined &&
    text(laneId) && !/[^a-zA-Z0-9_-]/.test(laneId) && laneId !== "main" && laneId !== "gateway",
    "Only local lane captures and exact lane IDs are eligible for shutdown");
  const main = status?.main?.socketPath;
  requireEvidence(absolute(main) && basename(dirname(main)) === "run" && join(dirname(main), "main.sock") === main &&
    Array.isArray(status.lanes), "Expected old managing CLI status with a main socket and lane inventory");
  const lanes = status.lanes.filter(lane => lane?.id === laneId);
  const [lane] = lanes;
  const path = join(dirname(main), `${laneId}.sock`);
  requireEvidence(lanes.length === 1 && isDeepStrictEqual(lane.placement, { target: "local" }) &&
    path === lane.socketPath && lane.socketPath === host.socketPath && lane.sessionId === host.sessionId,
    "Local lane identity or socket does not match the managing CLI target");
  const before = socket(path);
  const mainEntry = entry(main);
  requireEvidence(isDeepStrictEqual(host.socket, before) &&
    (!mainEntry || (mainEntry.isSocket() && !isDeepStrictEqual(inode(mainEntry), before))),
    "Captured socket changed or cannot be distinguished from HEAD");
  await withHost(path, async live => {
    const current = hostEvidence({ socketPath: path, expectedSession: host.sessionId, worker: false }, before, live);
    requireEvidence(isDeepStrictEqual(current, host), "Captured ownership changed; shutdown was not sent");
    await live.shutdown();
  });
  return { result: "shutdown-accepted" };
}

function headAtRest(head) {
  const terminal = [undefined, "complete", "refused"];
  return terminal.includes(head.rotation?.stage) && [...terminal, "sleeping"].includes(head.hibernation?.stage);
}

async function captureGateway(socketPath) {
  const before = socket(socketPath);
  const { gateway, head } = await gatewayStatus(socketPath);
  requireEvidence(gateway.stopping === false && validPid(gateway.pid) && exists(gateway.pid) &&
    absolute(head.socketPath) && headAtRest(head),
    "Gateway is stopping or did not identify live ownership");
  const sleeping = head.hibernation?.stage === "sleeping";
  if (sleeping) {
    requireEvidence(head.pid === null && head.connected === false && head.ready === false && !head.error &&
      text(head.hibernation.sessionId) && !entry(head.socketPath), "HEAD sleep was not confirmed");
  }
  const native = sleeping ? { kind: "sleeping", socketPath: head.socketPath, sessionId: head.hibernation.sessionId }
    : await captureHost({ socketPath: head.socketPath, expectedSession: head.initialization?.sessionId, worker: false });
  const after = await gatewayStatus(socketPath);
  requireEvidence(after.gateway.pid === gateway.pid && after.gateway.stopping === false && headAtRest(after.head) &&
    isDeepStrictEqual(before, socket(socketPath)) && head.socketPath === after.head.socketPath &&
    (sleeping ? after.head.hibernation?.stage === "sleeping" && after.head.hibernation.sessionId === native.sessionId &&
      after.head.pid === null && !after.head.error && !entry(head.socketPath)
      : head.pid === native.pid && after.head.pid === native.pid && after.head.initialization?.sessionId === native.sessionId),
    "Gateway or HEAD identity changed during capture");
  return { kind: "gateway", socketPath, socket: before, pid: gateway.pid, head: native };
}

function exited(pid, path) {
  requireEvidence(!exists(pid) && !entry(path), `PID ${pid} still exists or socket is still present: ${path}`);
}

function verifyHost(host) {
  requireEvidence(host?.kind === "host" && host.pid !== host.ownerPid && text(host.sessionId) &&
    (host.priorReceipt === null || text(host.priorReceipt?.dev) && text(host.priorReceipt?.ino)),
    "Missing captured Host or prior-receipt identity");
  exited(host.pid, host.socketPath);
  requireEvidence(!exists(host.ownerPid), `Host owner PID ${host.ownerPid} still exists`);
  const path = `${host.socketPath}.exit.json`;
  const stat = entry(path);
  ownedFile(stat, path, 0o077n);
  requireEvidence(!isDeepStrictEqual(host.priorReceipt, inode(stat)), `Exit receipt predates capture: ${path}`);
  const receipt = privateJson(path, stat);
  requireEvidence(receipt?.pid === host.pid && receipt.ownerPid === host.ownerPid &&
    receipt.sessionId === host.sessionId && receipt.sessionFile === host.sessionFile &&
    receipt.workerAttempt === host.workerAttempt && receipt.code === 0 && receipt.signal === null &&
    receipt.persisted === true && receipt.observationsFlushed === true, `Exit receipt does not match or prove clean exit: ${path}`);
  requireEvidence(isDeepStrictEqual(journal(host.sessionFile, host.workerAttempt !== undefined), host.journal),
    "Managed journal no longer matches the captured file");
}

async function run(args) {
  const [mode, kind, path, sessionId, worker] = args;
  if (mode === "capture") {
    if (kind === "gateway" && args.length === 3) return { machine, endpoint: await captureGateway(path) };
    if (kind === "host" && (args.length === 4 || (args.length === 5 && worker === "--worker")))
      return { machine, endpoint: await captureHost({ socketPath: path, expectedSession: sessionId, worker: worker === "--worker" }) };
  } else if (((mode === "verify" || mode === "recheck") && args.length === 2) || (mode === "stop-local" && args.length === 4)) {
    const value = privateJson(kind, entry(kind));
    const endpoint = value?.endpoint;
    requireEvidence(isDeepStrictEqual(value?.machine, machine) && ["gateway", "host"].includes(endpoint?.kind),
      "Use the unedited capture on the same machine under the same OS account");
    if (mode === "stop-local") return stopLocal(endpoint, privateJson(path, entry(path), logicalLimit), sessionId);
    if (mode === "recheck") {
      const current = endpoint.kind === "gateway" ? await captureGateway(endpoint.socketPath)
        : await captureHost({ socketPath: endpoint.socketPath, expectedSession: endpoint.sessionId,
          worker: endpoint.workerAttempt !== undefined });
      requireEvidence(isDeepStrictEqual(current, endpoint), "Captured ownership changed; do not stop or replace files");
    } else if (endpoint.kind === "gateway") {
      exited(endpoint.pid, endpoint.socketPath);
      if (endpoint.head.kind === "sleeping") {
        requireEvidence(!entry(endpoint.head.socketPath), "A HEAD socket appeared after sleep was captured");
      } else {
        verifyHost(endpoint.head);
      }
    } else {
      verifyHost(endpoint);
    }
    return { result: mode === "verify" ? "exit-confirmed" : "identity-unchanged", endpoint };
  }
  throw new Unconfirmed(usage);
}

try {
  console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2));
} catch (error) {
  console.error(error instanceof Unconfirmed ? error.message : "Could not read the private endpoint or evidence file");
  process.exitCode = 1;
}
