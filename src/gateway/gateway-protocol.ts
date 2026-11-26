import { createHash } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../config/config";
import type { InboundAttachmentBatch, InboundAttachmentReceipt } from "../contracts";
import { DeliveryError } from "../messaging/delivery";
import type { GatewayStatus } from "./gateway-wire";

export const MAX_GATEWAY_FRAME = 16 * 1024 * 1024;
export const MAX_GATEWAY_ATTACHMENT = 20 * 1024 * 1024;
export const MAX_GATEWAY_ATTACHMENT_BATCH = 40 * 1024 * 1024;
export interface GatewayResult { ok: boolean; value?: unknown; error?: string; certainty?: "rejected" | "uncertain"; retryAfterMs?: number }
export type GatewaySocketIdentity = { readonly dev: number; readonly ino: number };
export type GatewayEventConnection = {
  readonly stream: IncomingMessage;
  readonly socket: GatewaySocketIdentity;
  readonly reserveHistory: boolean;
};

export class GatewaySocketChangedError extends DeliveryError {
  constructor(certainty: "rejected" | "uncertain") {
    super("Gateway socket changed during request", certainty);
  }
}

export function gatewayPaths(config: Pick<Config, "stateDir">) {
  const socketPath = join(config.stateDir, "run", "gateway.sock");
  if (Buffer.byteLength(socketPath) > 100) throw new Error("stateDir is too long for the Gateway socket");
  return { socketPath, logPath: join(config.stateDir, "logs", "gateway.log") };
}

export async function gatewayStatus(config: Config): Promise<GatewayStatus | null> {
  const path = gatewayPaths(config).socketPath;
  if (!existsSync(path)) return null;
  return gatewayCall<GatewayStatus>(path, "/status");
}

export async function trustedGatewaySocket(socketPath: string): Promise<GatewaySocketIdentity> {
  const directory = await lstat(dirname(socketPath));
  const stat = await lstat(socketPath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() ||
      (directory.mode & 0o777) !== 0o700 || !stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new DeliveryError("Gateway endpoint is not a private owned Unix socket", "rejected");
  return { dev: stat.dev, ino: stat.ino };
}

function requireSameSocket(expected: GatewaySocketIdentity, actual: GatewaySocketIdentity, certainty: "rejected" | "uncertain"): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) throw new GatewaySocketChangedError(certainty);
}

async function verifyResponseSocket(socketPath: string, expected: GatewaySocketIdentity): Promise<void> {
  const actual = await trustedGatewaySocket(socketPath).catch(cause => {
    throw new DeliveryError("Gateway socket could not be verified after request", "uncertain", undefined, { cause });
  });
  requireSameSocket(expected, actual, "uncertain");
}

export async function readGatewayJson(stream: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > MAX_GATEWAY_FRAME) throw new DeliveryError("Gateway frame exceeds size limit", "rejected");
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** One attempt only. A lost response is never converted to a known rejection. */
export async function gatewayRequest(socketPath: string, endpoint: string, body?: unknown, options: {
  token?: string; clientId?: string; signal?: AbortSignal; timeoutMs?: number; expectedSocket?: GatewaySocketIdentity;
} = {}): Promise<IncomingMessage> {
  const before = await trustedGatewaySocket(socketPath);
  if (options.expectedSocket) requireSameSocket(options.expectedSocket, before, "rejected");
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (data && data.length > MAX_GATEWAY_FRAME) throw new DeliveryError("Gateway frame exceeds size limit", "rejected");
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  let answered = false;
  const req = request({ socketPath, path: endpoint, method: body === undefined ? "GET" : "POST",
    ...(options.expectedSocket ? { agent: false } : {}),
    headers: { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.clientId ? { "x-gateway-client": options.clientId } : {}) }, signal: options.signal,
  }, response => {
    answered = true;
    clearTimeout(timer);
    void verifyResponseSocket(socketPath, before).then(
      () => resolve(response),
      error => { response.destroy(); reject(error); },
    );
  });
  const timer = setTimeout(() => req.destroy(new Error("Gateway request timed out")), options.timeoutMs ?? 30_000);
  timer.unref();
  req.on("error", cause => {
    clearTimeout(timer);
    if (!answered) reject(new DeliveryError("Gateway request outcome uncertain", "uncertain", undefined, { cause }));
  });
  if (data) req.write(data);
  req.end();
  return promise;
}

export async function gatewayCall<T>(socketPath: string, endpoint: string, body?: unknown, options?: Parameters<typeof gatewayRequest>[3]): Promise<T> {
  const response = await gatewayRequest(socketPath, endpoint, body, options);
  const expected = options?.expectedSocket;
  const json = readGatewayJson(response);
  const result = await (expected ? json.finally(() => verifyResponseSocket(socketPath, expected)) : json) as GatewayResult;
  if (!result.ok) throw new DeliveryError(result.error ?? "Gateway rejected operation", result.certainty ?? "uncertain", result.retryAfterMs);
  return result.value as T;
}

/** An attachment and its event stream must authorize on the same verified inode. */
export async function openGatewayEvents(socketPath: string, attach: {
  readonly token: string; readonly clientId: string; readonly pid: number; readonly resumed: boolean;
  readonly startupHistory: boolean; readonly signal: AbortSignal;
}): Promise<GatewayEventConnection> {
  const { pid, resumed, startupHistory, signal, ...auth } = attach;
  const socket = await trustedGatewaySocket(socketPath);
  const options = { ...auth, expectedSocket: socket };
  const attachment = await gatewayCall<unknown>(socketPath, "/attach", {
    pid, resumed, ...(startupHistory ? { startupHistory } : {}),
  }, { ...options, signal });
  let reserveHistory = false;
  if (startupHistory) {
    if (!attachment || typeof attachment !== "object" || !("admissionReady" in attachment)
      || typeof attachment.admissionReady !== "boolean")
      throw new DeliveryError("Gateway does not support ordered startup history. Restart Gateway and HEAD together using the same installation.", "rejected");
    reserveHistory = !attachment.admissionReady;
  }
  // The delivery stream outlives startup; its owner destroys it at detach.
  signal.throwIfAborted();
  const stream = await gatewayRequest(socketPath, "/events", undefined, options);
  if (stream.statusCode !== 200) {
    try {
      const result = await readGatewayJson(stream).finally(() => verifyResponseSocket(socketPath, socket)) as GatewayResult;
      throw new DeliveryError(result.error ?? "Gateway event stream rejected", result.certainty ?? "rejected");
    } finally { stream.destroy(); }
  }
  return { stream, socket, reserveHistory };
}

/** A spool reply carries only correctly indexed local references, never attachment bytes. */
export async function parseInboundAttachmentReceipt(
  socketPath: string, batch: InboundAttachmentBatch, value: unknown,
): Promise<InboundAttachmentReceipt> {
  const invalid = () => new DeliveryError("Invalid attachment spool receipt", "uncertain");
  if (!value || typeof value !== "object" || !("receipt" in value) || !("files" in value)
    || typeof value.receipt !== "string" || !/^[a-f0-9]{64}$/.test(value.receipt)
    || !Array.isArray(value.files) || value.files.length !== batch.attachments.length) throw invalid();
  const directory = join(await realpath(dirname(dirname(socketPath))), "attachments", value.receipt);
  const digest = createHash("sha256").update(createHash("sha256").update(batch.inputId).digest());
  let total = 0;
  const files: InboundAttachmentReceipt["files"][number][] = [];
  for (const [index, attachment] of batch.attachments.entries()) {
    const file: unknown = value.files[index];
    if (!file || typeof file !== "object" || !("path" in file) || !("size" in file) || !("mimeType" in file)
      || file.path !== join(directory, String(index)) || typeof file.size !== "number"
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_GATEWAY_ATTACHMENT
      || (attachment.size !== null && file.size !== attachment.size)
      || !("sha256" in file) || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)
      || typeof file.mimeType !== "string"
      || !["application/octet-stream", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mimeType))
      throw invalid();
    total += file.size;
    if (total > MAX_GATEWAY_ATTACHMENT_BATCH) throw invalid();
    digest.update(Buffer.from(file.sha256, "hex"));
    files.push({ path: file.path, size: file.size, mimeType: file.mimeType, sha256: file.sha256 });
  }
  if (digest.digest("hex") !== value.receipt) throw invalid();
  return { receipt: value.receipt, files };
}
