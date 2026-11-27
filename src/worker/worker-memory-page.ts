import { redactMemorySecrets } from "@oh-my-pi/pi-coding-agent/memory-backend/redact";
import { CREDENTIAL_PATTERNS } from "@oh-my-pi/pi-coding-agent/secrets/patterns";
import { Type } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";

export const WORKER_MEMORY_ROWS = 16;
export const WORKER_MEMORY_TEXT_BYTES = 2048;
export const WORKER_MEMORY_PAGE_BYTES = 24 * 1024;
export const workerMemoryId = /^[0-9a-f]{16}$/u;
const workerMemoryStamp = /^[0-9a-f]{64}$/u;
const credentialPatterns = CREDENTIAL_PATTERNS.map(({ source, flags }) => new RegExp(source, flags));
const telegramToken = /(?:^|[^A-Za-z0-9_])(?:bot)?\d{6,16}(?::|%3a)[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/iu;
const telegramBotPath = /^\/(?:file\/)?bot\d+:[^/]+(?:\/|$)/iu;
const webhookPath = /\/(?:webhooks?|download|signed|private)(?:\/|$)/iu;
const slackCapability = /(?:^|[^A-Za-z0-9_-])xapp-[A-Za-z0-9_-]{12,}|\bhooks\.slack(?:-gov)?\.com\/(?:services|commands|workflows)\//iu;
const discordToken = /(?:^|[^\w-])(?:Bot\s+[\w-]+\.[\w-]+\.[\w-]+|[MNO][\w-]{21,27}\.[\w-]{6}\.[\w-]{20,}|mfa\.[\w-]{20,})(?![\w-])/iu;

const strict = { additionalProperties: false } as const;
const cursor = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const schema = Type.Object({
  after: cursor,
  next: cursor,
  stamp: Type.String({ minLength: 64, maxLength: 64 }),
  records: Type.Array(Type.Object({
    at: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    id: Type.String({ minLength: 16, maxLength: 16 }),
    content: Type.String({ minLength: 1, maxLength: WORKER_MEMORY_TEXT_BYTES }),
  }, strict), { maxItems: WORKER_MEMORY_ROWS }),
}, strict);

export type WorkerMemoryRecord = { readonly at: number; readonly id: string; readonly content: string };
export type WorkerMemoryPage = {
  readonly after: number;
  readonly next: number;
  readonly stamp: string;
  readonly records: readonly WorkerMemoryRecord[];
};

export const isWorkerMemoryCursor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const isWorkerMemoryStamp = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && workerMemoryStamp.test(value);

export function safeWorkerMemoryText(text: string): boolean {
  if (text.length > WORKER_MEMORY_TEXT_BYTES || !text.trim() || Buffer.byteLength(text, "utf8") > WORKER_MEMORY_TEXT_BYTES
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]|data:[^ ]*,|\[redacted\]|<\/?(?:system|developer|assistant|user|memories|tool_call|system-reminder)\b/iu.test(text)
    || /\b(?:bearer\s+\S|(?:authorization|(?:set-)?cookie)\s*:|(?:password|passphrase|secret|api[_ -]?key|access[_ -]?token|client[_ -]?secret)\s*[:=]|-----begin\s+[\w ]*private key)|(?:^|\s)\w+@[\w.-]+:\S/iu.test(text)
    || telegramToken.test(text) || slackCapability.test(text) || discordToken.test(text) || /\/api\/(?:v\d+\/)?webhooks\/\d+\/\S/iu.test(text)
    || credentialPatterns.some(pattern => pattern.test(text)) || redactMemorySecrets(text) !== text)
    return false;
  for (const link of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/giu)) {
    try {
      const url = new URL(link[0]);
      const path = decodeURIComponent(url.pathname);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
        || url.search || url.hash || webhookPath.test(path) || telegramToken.test(path) || telegramBotPath.test(path)
        || (/^hooks\.slack(?:-gov)?\.com\.?$/iu.test(url.hostname) && /^\/(?:services|commands|workflows)(?:\/|$)/iu.test(path))
        || (url.hostname.replace(/\.$/u, "") === "api.telegram.org" && /^\/(?:file\/)?bot[^/]+(?:\/|$)/iu.test(path))) return false;
    } catch { return false; }
  }
  return true;
}

export class WorkerMemoryPageError extends Error {}

/** Zero is end-of-scan, not an error or a request to skip the final records. */
export function parseWorkerMemoryPage(value: unknown, after: number): WorkerMemoryPage {
  if (!isWorkerMemoryCursor(after) || !Value.Check(schema, value) || value.after !== after || !isWorkerMemoryStamp(value.stamp)
    || (value.next !== 0 && value.next <= after))
    throw new WorkerMemoryPageError("Invalid worker memory page");
  let previous = after;
  const ids = new Set<string>();
  for (const record of value.records) {
    if (record.at <= previous || (value.next !== 0 && record.at > value.next)
      || !workerMemoryId.test(record.id) || ids.has(record.id) || !safeWorkerMemoryText(record.content))
      throw new WorkerMemoryPageError("Invalid worker memory record");
    previous = record.at;
    ids.add(record.id);
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > WORKER_MEMORY_PAGE_BYTES)
    throw new WorkerMemoryPageError("Worker memory page exceeds its byte limit");
  return value;
}
