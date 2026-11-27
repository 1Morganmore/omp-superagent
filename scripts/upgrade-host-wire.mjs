import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

export const probeTimeoutMs = 5000;
export const wireLimit = 1024 * 1024;
// Match the stock output codec used by the v0.1.10 owner, not its input limit.
const chunkSize = 256 * 1024;
const chunkCount = 256;
export const logicalLimit = chunkSize * chunkCount;
const base64Limit = Math.ceil(chunkSize / 3) * 4;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export class Unconfirmed extends Error {}

export function requireEvidence(condition, problem) {
  if (!condition) throw new Unconfirmed(problem);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readFrame(bytes) {
  let frame;
  try {
    frame = JSON.parse(utf8.decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new Unconfirmed("Invalid Host wire JSON");
    throw error;
  }
  requireEvidence(object(frame), "Host wire frame was not an object");
  return frame;
}

class Chunks {
  #pending;

  accept(frame, version) {
    const pending = this.#pending;
    if (frame.type !== "rpc_chunk") {
      requireEvidence(!pending, "Host chunk sequence interrupted");
      return frame;
    }
    const { chunkId, index, count, byteLength, data } = frame;
    requireEvidence(version === 2 && typeof chunkId === "string" && chunkId.length > 0 && chunkId.length <= 128 &&
      Number.isInteger(count) && count >= 2 && count <= chunkCount && Number.isInteger(index) && index >= 0 && index < count &&
      Number.isInteger(byteLength) && byteLength >= wireLimit && byteLength <= count * chunkSize,
      "Invalid Host chunk metadata");
    requireEvidence(pending
      ? chunkId === pending.chunkId && count === pending.count && byteLength === pending.byteLength && index === pending.parts.length
      : index === 0, "Host chunk sequence mismatch");
    requireEvidence(typeof data === "string" && data.length > 0 && data.length <= base64Limit,
      "Invalid Host chunk payload size");
    const bytes = Buffer.from(data, "base64");
    requireEvidence(bytes.length <= chunkSize && bytes.toString("base64") === data, "Invalid Host chunk base64");
    const received = (pending?.received ?? 0) + bytes.length;
    const remaining = count - index - 1;
    requireEvidence(received + remaining <= byteLength && byteLength <= received + remaining * chunkSize,
      "Host chunk sequence length mismatch");
    const parts = pending?.parts ?? [];
    parts.push(bytes);
    if (remaining > 0) {
      this.#pending = { chunkId, count, byteLength, received, parts };
      return;
    }
    this.#pending = undefined;
    const decoded = readFrame(Buffer.concat(parts, byteLength));
    requireEvidence(decoded.type !== "rpc_chunk", "Nested Host chunks are invalid");
    return decoded;
  }

  get incomplete() {
    return this.#pending !== undefined;
  }
}

async function* frames(peer, protocol) {
  const line = Buffer.alloc(wireLimit);
  const chunks = new Chunks();
  let length = 0;
  for await (const data of peer) {
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start);
      const end = newline < 0 ? data.length : newline;
      requireEvidence(length + end - start < wireLimit, "Host frame exceeded size limit");
      line.set(data.subarray(start, end), length);
      length += end - start;
      if (newline < 0) break;
      const bytes = line.subarray(0, length);
      length = 0;
      start = end + 1;
      if (bytes.every(byte => byte === 32 || byte === 9 || byte === 13)) continue;
      const decoded = chunks.accept(readFrame(bytes), protocol.version);
      if (decoded) yield decoded;
    }
  }
  requireEvidence(length === 0 && !chunks.incomplete, "Host disconnected with an incomplete frame");
}

async function timed(peer, timeout, operation) {
  const timer = setTimeout(() => peer.destroy(new Unconfirmed("Host request timed out")), timeout);
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
  }
}

export async function withHost(path, use) {
  const peer = createConnection(path);
  const protocol = { version: 1 };
  const input = frames(peer, protocol);
  async function read() {
    const next = await input.next();
    requireEvidence(!next.done, "Host disconnected before replying");
    return next.value;
  }
  async function command(type, fields) {
    const id = randomUUID();
    peer.write(JSON.stringify({ type, id, ...fields }) + "\n");
    for (;;) {
      const frame = await read();
      if (frame.type === "response" && frame.id === id) {
        requireEvidence(frame.command === type, "Host returned a mismatched response");
        return frame;
      }
    }
  }
  try {
    const { state, workerIdentity } = await timed(peer, probeTimeoutMs, async () => {
      const ready = await read();
      requireEvidence(ready.type === "ready" && ready.protocolVersion === 1, "Not the old Host JSONL protocol");
      if (Array.isArray(ready.supportedProtocolVersions) && ready.supportedProtocolVersions.includes(2)) {
        const negotiated = await command("negotiate_protocol", { protocolVersion: 2 });
        requireEvidence(negotiated.success === true && negotiated.data?.protocolVersion === 2, "Host did not negotiate protocol v2");
        protocol.version = 2;
      }
      const reply = await command("get_state");
      requireEvidence(reply.success === true && object(reply.data), "Host did not return owned native state");
      return { state: reply.data, workerIdentity: ready.workerIdentity };
    });
    async function shutdown() {
      let ack;
      try {
        // Preserve the old CLI's request deadline, separate from the identity probe.
        ack = await timed(peer, 30_000, () => command("shutdown_host"));
      } catch (error) {
        if (error instanceof Error) throw new Unconfirmed("Host shutdown acknowledgement was lost; do not retry");
        throw error;
      }
      requireEvidence(ack.success !== false, "Host refused graceful shutdown");
      requireEvidence(ack.success === true && ack.data?.shutdown === true &&
        ack.data.sessionId === state.sessionId && ack.data.sessionFile === state.sessionFile,
        "Host shutdown acknowledgement did not confirm the verified session; do not retry");
    }
    return await use({ state, workerIdentity, shutdown });
  } finally {
    peer.destroy();
    await input.return();
  }
}
