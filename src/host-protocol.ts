import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder, RpcFrameEncoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { RpcResponse, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { LanePresetSnapshot } from "./contracts";

/** Private adapter observations, not additions to the stock RPC protocol. */
export type HostState = RpcSessionState & {
  hostPid: number;
  adapterOwnerPid: number;
  adapterProtocol: "owned-stock-stdio-v1";
  settingsScope: "session";
  modelSettings: LanePresetSnapshot;
  hasOwnedRunningWork: boolean;
  pendingUiRequests: Record<string, unknown>[];
};
export type Frame = Record<string, unknown>;
export type Response = Frame & { success: boolean; data?: unknown; error?: string };
export type HostResponse = RpcResponse | {
  type: "response"; id?: string; command: "shutdown_host" | "set_model_preset" | "get_host_admission"; success: true; data: Frame;
} | {
  type: "response"; id?: string; command: string; success: false; error: string; code?: string;
};
export class HostRequestTimeout extends Error {
  constructor() { super("Host request timed out; its outcome may be unknown"); }
}

/** Positive native journal evidence for this exact terminal service generation. */
export function serviceCompletionRecorded(daemon: Frame, entries: readonly unknown[]): boolean {
  if (typeof daemon.owner !== "string" || typeof daemon.id !== "string" || typeof daemon.startedAt !== "number"
    || typeof daemon.restartCount !== "number" || typeof daemon.exitedAt !== "number"
    || !["exited", "failed"].includes(String(daemon.state))) return false;
  return entries.some(value => {
    if (!value || typeof value !== "object") return false;
    const entry = value as Frame;
    const details = entry.details as Frame | undefined;
    return entry.type === "custom_message" && entry.customType === "launch-completion"
      && Array.isArray(details?.daemons) && details.daemons.some(value => {
        if (!value || typeof value !== "object") return false;
        const observed = value as Frame;
        return ["owner", "id", "startedAt", "restartCount", "state", "exitedAt"]
          .every(field => daemon[field] === observed[field]);
      });
  });
}

/** Public native JSONL/v2 framing, with correlation owned by this adapter. */
export class HostChannel extends EventEmitter {
  readonly pending = new Map<string, {
    resolve(value: Response): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>;
  }>();
  readonly exited: Promise<void>;
  readonly ready = Promise.withResolvers<void>();
  readonly encoder = new RpcFrameEncoder();
  #closed = false;
  constructor(readonly input: Readable, readonly output: Writable, readonly framed = false) {
    super();
    const closed = Promise.withResolvers<void>();
    this.exited = closed.promise;
    const decoder = new RpcFrameDecoder();
    const text = new StringDecoder("utf8");
    let buffer = "";
    input.on("data", (chunk: string | Buffer) => {
      try {
        buffer += typeof chunk === "string" ? chunk : text.write(chunk);
        if (Buffer.byteLength(buffer) > MAX_RPC_REASSEMBLED_BYTES) throw new Error("Host frame backlog exceeded its bound");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          const decoded = decoder.push(JSON.parse(line));
          if (!decoded) continue;
          const frame = decoded as Frame;
          if (frame.type === "ready") this.ready.resolve();
          if (frame.type === "response" && typeof frame.id === "string") {
            const request = this.pending.get(frame.id);
            if (request) {
              this.pending.delete(frame.id);
              clearTimeout(request.timer);
              request.resolve(frame as Response);
            }
          }
          this.emit("frame", frame);
        }
      } catch (error) { this.destroy(error instanceof Error ? error : new Error(String(error))); }
    });
    const finish = () => {
      if (this.#closed) return;
      this.#closed = true;
      const error = new Error("Host disconnected; request outcome may be unknown");
      this.ready.reject(error);
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear();
      closed.resolve();
    };
    void this.ready.promise.catch(() => {});
    input.on("error", finish);
    input.on("end", finish);
    input.on("close", finish);
    output.on("error", finish);
  }
  send(frame: Frame): void {
    if (this.#closed || this.output.destroyed) throw new Error("Host is disconnected");
    for (const data of this.framed ? this.encoder.encodeFrames(frame) : [`${JSON.stringify(frame)}\n`]) {
      // Include protocol-v2 base64/chunk overhead within a bounded wire queue.
      if (Buffer.byteLength(data) + this.output.writableLength > MAX_RPC_REASSEMBLED_BYTES * 2) {
        this.destroy(new Error("Host write backlog exceeded its bound"));
        throw new Error("Host write backlog exceeded its bound");
      }
      this.output.write(data);
    }
  }
  request(frame: Frame, id: string = crypto.randomUUID(), timeoutMs = 10_000): Promise<Response> {
    if (this.pending.has(id)) throw new Error(`Request ${id} is already outstanding`);
    if (Buffer.byteLength(JSON.stringify(frame)) > 16 * 1024 * 1024) {
      this.destroy();
      return Promise.reject(new Error("Host write backlog exceeded its bound"));
    }
    const result = Promise.withResolvers<Response>();
    const timer = timeoutMs > 0 ? setTimeout(() => {
      this.pending.delete(id);
      result.reject(new HostRequestTimeout());
    }, timeoutMs) : undefined;
    timer?.unref();
    this.pending.set(id, { ...result, timer });
    try { this.send({ ...frame, id }); }
    catch (error) { this.pending.delete(id); clearTimeout(timer); result.reject(error); }
    return result.promise;
  }
  destroy(error?: Error): void {
    this.input.destroy(error);
    this.output.destroy();
  }
}
