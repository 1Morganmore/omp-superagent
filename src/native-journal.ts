import { constants, type Stats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";

// OMP 19.2.1 docs/session.md: JSONL with an optional initial title slot.
// Older versions share the header identity; native resume owns migrations.
const HEADER_LIMIT = 1024 * 1024;
const CHUNK_BYTES = 16 * 1024;
const UTF8_BOM = Buffer.from("\uFEFF");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Entry = Readonly<Record<string, unknown>> & { readonly type: string };
type FileIdentity = Pick<Stats, "dev" | "ino">;
type Journal = { readonly file: FileHandle; readonly initial: Stats };

export class NativeJournalFormatError extends Error {
  constructor() { super("Unrecognized or incomplete native session journal"); }
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.ino === right.ino && left.dev === right.dev;
}

async function openJournal(path: string, expected?: FileIdentity): Promise<Journal | undefined> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (expected ? constants.O_NOFOLLOW : 0));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      return undefined;
    throw error;
  }
  try {
    const initial = await file.stat();
    if (!initial.isFile() || expected && !sameFile(initial, expected)) throw new NativeJournalFormatError();
    return { file, initial };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function* jsonRecords(file: FileHandle, length: number): AsyncGenerator<unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const pending: Buffer[] = [];
  let firstLine = true;
  for (let offset = 0; offset < length;) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, length - offset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) throw new NativeJournalFormatError();
    offset += bytesRead;
    const chunk = buffer.subarray(0, bytesRead);
    try { decoder.decode(chunk, { stream: true }); }
    catch (error) {
      if (error instanceof TypeError) throw new NativeJournalFormatError();
      throw error;
    }
    const newline = chunk.lastIndexOf(0x0a);
    if (newline === -1) { pending.push(chunk); continue; }
    const throughNewline = chunk.subarray(0, newline + 1);
    let complete = pending.length ? Buffer.concat([...pending, throughNewline]) : throughNewline;
    if (firstLine) {
      complete = complete.subarray(titleSlotEnd(complete));
      firstLine = false;
    }
    // parseChunk strips a BOM at the start of *each* byte buffer. After the
    // optional title line, every window contains JSON, never a new byte stream.
    if (complete.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) throw new NativeJournalFormatError();
    const { values, read, error, done } = Bun.JSONL.parseChunk(complete);
    for (const value of values) yield value;
    if (error) throw new NativeJournalFormatError();
    pending.length = 0;
    if (!done && read < complete.length) pending.push(complete.subarray(read));
    if (newline + 1 < chunk.length) pending.push(chunk.subarray(newline + 1));
  }
  try { decoder.decode(); }
  catch (error) {
    if (error instanceof TypeError) throw new NativeJournalFormatError();
    throw error;
  }
  if (pending.length) throw new NativeJournalFormatError();
}

function isEntry(value: unknown): value is Entry {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "type" in value && typeof value.type === "string";
}

function titleSlot(entry: Entry): boolean {
  return entry.type === "title" && entry.v === 1 && typeof entry.title === "string"
    && typeof entry.updatedAt === "string" && typeof entry.pad === "string"
    && (entry.source === undefined || entry.source === "auto" || entry.source === "user");
}

/** Only a complete title record on the first physical line is outside the journal. */
function titleSlotEnd(prefix: Buffer): number {
  const lf = prefix.indexOf(0x0a);
  if (lf < 0) return 0;
  try {
    const entry: unknown = JSON.parse(utf8.decode(prefix.subarray(0, lf)).trim());
    return isEntry(entry) && titleSlot(entry) ? lf + 1 : 0;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return 0;
    throw error;
  }
}

function headerId(prefix: Buffer): string | undefined {
  // Stock trims the physical title line, but skips only JSON whitespace
  // before a header. In particular, a BOM is not a header prefix.
  let start = titleSlotEnd(prefix);
  while (start < prefix.length) {
    const byte = prefix[start];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) break;
    start++;
  }
  if (prefix[start] !== 0x7b) return undefined;

  // A header can span lines. Decode through its closing brace, not the body.
  let depth = 0;
  let quoted = false;
  for (let i = start; i < prefix.length; i++) {
    const byte = prefix[i];
    if (quoted && byte === 0x5c) { i++; continue; } // escaped byte inside a string
    if (byte === 0x22) quoted = !quoted;
    if (quoted) continue;
    if (byte === 0x7b) depth++;
    if (byte !== 0x7d) continue;
    depth--;
    if (depth !== 0) continue;
    try {
      const entry: unknown = JSON.parse(utf8.decode(prefix.subarray(start, i + 1)));
      if (isEntry(entry) && entry.type === "session" && typeof entry.id === "string" && entry.id) return entry.id;
      // A complete title object can still be waiting for its physical newline.
      return undefined;
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
    }
    throw new NativeJournalFormatError();
  }
  return undefined;
}

async function* journalRecords(journal: Journal): AsyncGenerator<Entry> {
  const { file, initial } = journal;
  let headerSeen = false;
  for await (const entry of jsonRecords(file, initial.size)) {
    if (!isEntry(entry)) throw new NativeJournalFormatError();
    if (!headerSeen) {
      if (entry.type !== "session" || typeof entry.id !== "string" || !entry.id)
        throw new NativeJournalFormatError();
      headerSeen = true;
    } else if (entry.type === "session" || entry.type === "title") {
      throw new NativeJournalFormatError();
    }
    yield entry;
  }
  if (!headerSeen) throw new NativeJournalFormatError();
}

/** Read a bounded identity prefix. Only a missing path is reported as absent. */
export async function readNativeSessionId(path: string, expected?: FileIdentity): Promise<string | undefined> {
  const journal = await openJournal(path, expected);
  if (!journal) return undefined;
  try {
    const limit = Math.min(journal.initial.size, HEADER_LIMIT);
    let prefix = Buffer.alloc(0);
    while (prefix.length < limit) {
      const remaining = Math.min(limit - prefix.length, Math.max(CHUNK_BYTES, prefix.length));
      const chunk = Buffer.allocUnsafe(remaining);
      const { bytesRead } = await journal.file.read(chunk, 0, remaining, prefix.length);
      if (!bytesRead) break;
      const read = chunk.subarray(0, bytesRead);
      prefix = prefix.length ? Buffer.concat([prefix, read]) : read;
      const id = headerId(prefix);
      if (id !== undefined) {
        if (!sameFile(journal.initial, await stat(path))) throw new NativeJournalFormatError();
        return id;
      }
    }
    throw new NativeJournalFormatError();
  } finally { await journal.file.close(); }
}

/**
 * Visit the original records, not a reconstructed active branch. Compaction,
 * blob references and spill links inside ordinary entries are opaque; they
 * cannot supply an observation that did not persist inline.
 */
export async function scanNativeJournal(path: string, visit: (entry: Entry) => void): Promise<string | undefined> {
  const journal = await openJournal(path);
  if (!journal) throw new NativeJournalFormatError();
  try {
    let sessionId: string | undefined;
    for await (const entry of journalRecords(journal)) {
      if (entry.type === "session" && typeof entry.id === "string") sessionId = entry.id;
      else visit(entry);
    }
    const after = await stat(path);
    const { initial } = journal;
    if (sameFile(initial, after) && initial.size === after.size && initial.mtimeMs === after.mtimeMs
      && initial.ctimeMs === after.ctimeMs) return sessionId;
    return undefined;
  } catch (error) {
    if (error instanceof NativeJournalFormatError) return undefined;
    throw error;
  } finally { await journal.file.close(); }
}
