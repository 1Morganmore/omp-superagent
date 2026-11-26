import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

let isolated: string;
let executable: string;
beforeAll(async () => {
  isolated = await mkdtemp(join(tmpdir(), "sa-journal-"));
  const build = await Bun.$`cargo build --locked --manifest-path host-owner/Cargo.toml --example native-journal --message-format=json-render-diagnostics`
    .cwd(resolve(import.meta.dir, "..")).quiet();
  for (const line of build.text().trim().split("\n")) {
    const artifact = JSON.parse(line);
    if (artifact.reason === "compiler-artifact" && artifact.target.name === "native-journal"
      && artifact.target.kind.includes("example") && typeof artifact.executable === "string") {
      executable = artifact.executable;
      return;
    }
  }
  throw new Error("Cargo did not report the native-journal example executable");
}, 60_000);
afterAll(async () => { await rm(isolated, { recursive: true, force: true }); });

async function rust(args: string[], input?: unknown) {
  const child = Bun.spawn([executable, ...args], {
    cwd: isolated,
    env: { PATH: "", HOME: isolated },
    stdin: input === undefined ? "ignore" : Buffer.from(JSON.stringify(input)),
    stdout: "pipe", stderr: "pipe", timeout: 5_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const timestamp = "2026-11-25T08:00:00.000Z";
const titleSlot = serializeTitleSlot({ title: "Journal identity", updatedAt: timestamp });
const sessionId = "managed-native-session";
const header = { type: "session", version: 3, id: sessionId, timestamp, cwd: "/original/cwd" };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test.each([
  { format: "current title slot", bytes: titleSlot + line(header), id: sessionId },
  { format: "nonbreaking space before the title slot", bytes: "\u00a0" + titleSlot + line(header), id: sessionId },
  { format: "space and BOM before the title slot", bytes: " \uFEFF" + titleSlot + line(header), id: sessionId },
  { format: "title newline in the next read", bytes: titleSlot.trimEnd() + " ".repeat(16 * 1024) + "\n" + line(header), id: sessionId },
  { format: "slotless header after blank lines", bytes: "\r\n\n" + line(header), id: sessionId },
  { format: "multi-chunk nested header", bytes: line({ metadata: [{ note: '"}\\한'.repeat(4000) }], ...header }), id: sessionId },
  { format: "header with duplicate and escaped keys", bytes: String.raw`{"type":"session","id":"earlier","\u0069d":"managed-native-session"}`, id: sessionId },
  { format: "title slot and header with opaque extension keys", id: sessionId,
    bytes: titleSlot.replace("{", String.raw`{"title\ud800":null,`) + line({ ...header, ["id\uDC00"]: "extension" }) },
  { format: "complete header before a damaged delimiter", bytes: Buffer.concat([Buffer.from(JSON.stringify(header)), Buffer.from([0xff])]), id: sessionId },
  { format: "pre-slot v3", bytes: line(header), id: sessionId },
  { format: "v2", bytes: line({ ...header, version: 2 }), id: sessionId },
  { format: "unversioned v1", bytes: JSON.stringify({ ...header, version: undefined }, null, 2), id: sessionId },
  { format: "unchanged header envelope with newer metadata", bytes: line({ ...header, version: 4 }), id: sessionId },
  { format: "absent path", bytes: null, id: null },
])("Gateway's native reader reads $format identity without Bun or an installed SDK", async ({ bytes, id }) => {
  const dir = await mkdtemp(join(isolated, "id-"));
  const file = join(dir, "session.jsonl");
  if (bytes !== null) await writeFile(file, bytes);
  expect(await readSessionHeaderId(file) ?? null).toBe(id);
  const response = await rust(["session-id", file]);
  expect(response).toEqual({ code: 0, stdout: `${JSON.stringify(id)}\n`, stderr: "" });
  if (bytes === null) expect(await Bun.file(file).exists()).toBe(false);
});

test("Gateway refuses a journal without a leading native header instead of treating it as absent", async () => {
  const dir = await mkdtemp(join(isolated, "id-"));
  const file = join(dir, "session.jsonl");
  const bytes = line({ type: "ref", path: "local://1.log" }) + line({ ...header, id: "private-header-contents" });
  await writeFile(file, bytes);
  const response = await rust(["session-id", file]);
  expect(response.code).toBe(1);
  expect(response.stdout).toBe("");
  expect(response.stderr).not.toContain("private-header-contents");
  expect(await readFile(file, "utf8")).toBe(bytes);
});

test("Gateway's reader accepts ENOTDIR as missing but a directory or oversized header as invalid", async () => {
  const dir = await mkdtemp(join(isolated, "not-file-"));
  const file = join(dir, "prefix");
  await writeFile(file, " ".repeat(1024 * 1024) + line(header));
  expect(await rust(["session-id", join(file, "missing.jsonl")]))
    .toEqual({ code: 0, stdout: "null\n", stderr: "" });
  for (const path of [dir, file]) {
    const result = await rust(["session-id", path]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  }
});

const pid = 42;
const ownerPid = 43;
const instanceKey = "stock-host-instance";
// OMP terminal frames can lack a command id; the owner identifies observations by their journal entry id.
const frame = { type: "prompt_result", status: "completed", agentInvoked: true, sessionSettled: true };
const literalFrame = { ...frame, details: { "$serde_json::private::RawValue": '{"sample":"draft"}' } };
type Row = Readonly<Record<string, unknown>>;
const rows = (sessionFile: string) => {
  const identity = { hostPid: pid, instanceKey, sessionId, sessionFile, runOrdinal: 1 };
  const start = { type: "custom", id: "start", parentId: null, timestamp, customType: "rpc_agent_start", data: identity };
  const receipt = { type: "custom", id: "result", parentId: start.id, timestamp, customType: "rpc_prompt_result",
    data: { ...identity, frame } };
  return { start, receipt };
};

async function exitFixture(
  journal: (entries: ReturnType<typeof rows>) => string | Buffer | null,
  overrides: Readonly<Record<string, unknown>> = {},
  stage?: (dir: string, receiptPath: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(isolated, "exit-"));
  const sessionFile = join(dir, "session.jsonl");
  const socketPath = join(dir, "host.sock");
  const receiptPath = `${socketPath}.exit.json`;
  const bytes = journal(rows(sessionFile));
  if (bytes !== null) await writeFile(sessionFile, bytes);
  await stage?.(dir, receiptPath);
  const result = await rust(["exit", sessionFile, socketPath], {
    pid, ownerPid, sessionId, instanceKey, runOrdinal: 1, expectedObservations: [["result", frame]],
    workerAttempt: "fixture-attempt", code: 0, signal: null, observationFailure: false, ...overrides,
  });
  if (bytes !== null) expect((await readFile(sessionFile)).equals(Buffer.from(bytes))).toBe(true);
  expect((await readdir(dir)).filter(name => name.startsWith("host.sock.exit.json."))).toEqual([]);
  const receipt = Bun.file(receiptPath);
  return { result, receipt: await receipt.exists() ? await receipt.json() : null, receiptPath, sessionFile };
}

test.each([
  { prefixKind: "a title slot after a blank line", prefix: "\n" + titleSlot },
  { prefixKind: "a title slot across multiple lines", prefix: JSON.stringify(JSON.parse(titleSlot), null, 2) + "\n" },
  { prefixKind: "a BOM before a slotless header", prefix: "\uFEFF" },
  { prefixKind: "a BOM between title and header", prefix: titleSlot + "\uFEFF" },
])("Gateway and exit proof reject $prefixKind", async ({ prefix }) => {
  const { sessionFile, result, receipt } = await exitFixture(({ start, receipt }) =>
    prefix + [header, start, receipt].map(line).join(""));
  expect(await readSessionHeaderId(sessionFile)).toBeUndefined();
  const identity = await rust(["session-id", sessionFile]);
  expect(identity.code).toBe(1);
  expect(identity.stdout).toBe("");
  expect(result.code).toBe(1);
  expect(receipt).toMatchObject({ persisted: false, observationsFlushed: false });
});

test.each([16382, 16383, 16384, 16385])("exit proof rejects a body record prefixed with a BOM at byte %i", async offset => {
  const { result, receipt } = await exitFixture(({ start, receipt }) => {
    const records = [header, start, receipt].map(line).join("");
    const padding = " ".repeat(offset - Buffer.byteLength(records) - 1) + "\n";
    return records + padding + "\uFEFF" + line({ type: "message" });
  });
  expect(result.code).toBe(1);
  expect(receipt).toMatchObject({ persisted: false, observationsFlushed: false });
});

test.each([0, 32 * 1024])("body UTF-8 damage after %i padding bytes affects exit proof, not identity", async padding => {
  const { sessionFile, result, receipt } = await exitFixture(({ start, receipt }) => Buffer.concat([
    Buffer.from(titleSlot + [header, start, receipt].map(line).join("") + '{"type":"message","text":"' + "a".repeat(padding)),
    Buffer.from([0xff]), Buffer.from('"}\n'),
  ]));
  expect(await readSessionHeaderId(sessionFile)).toBe(sessionId);
  const identity = await rust(["session-id", sessionFile]);
  expect(identity).toEqual({ code: 0, stdout: `${JSON.stringify(sessionId)}\n`, stderr: "" });
  expect(result.code).toBe(1);
  expect(receipt).toMatchObject({ persisted: false, observationsFlushed: false });
});

test("exit proof accepts a complete multi-chunk multiline JSON record terminated by LF", async () => {
  const { result, receipt } = await exitFixture(({ start, receipt }) => {
    const entry = { type: "message", note: Array.from({ length: 2048 }, () => '"}한{') };
    return [header, start, receipt].map(line).join("") + JSON.stringify(entry, null, 2) + "\n";
  });
  expect(result.code).toBe(0);
  expect(receipt).toMatchObject({ persisted: true, observationsFlushed: true });
});

test("exit proof accepts opaque extension keys and still uses the last escaped observation ID", async () => {
  const { result, receipt } = await exitFixture(({ start, receipt }) => {
    const observation = line({ ...receipt, ["data\uD800"]: "extension" })
      .replace('"id":', String.raw`"id":"earlier","\u0069d":`);
    return line(header) + line(start) + observation;
  });
  expect(result.code).toBe(0);
  expect(receipt).toMatchObject({ persisted: true, observationsFlushed: true });
});

test("exit proof finds inline observations off the active branch without reading compacted blobs or spills", async () => {
  const { receipt, receiptPath, result, sessionFile } = await exitFixture(({ start, receipt }) => {
    // Size forces several chunks. The branch's ordinary tool payload carries references, not observations.
    const media = { type: "image", data: `blob:sha256:${"f".repeat(64)}`, mimeType: "image/png" };
    const tool = { type: "message", id: "tool", parentId: start.id, timestamp, message: {
      role: "toolResult", toolCallId: "fixture-spill", toolName: "mcp_fixture", isError: false,
      content: [{ type: "text", text: `${"한글".repeat(8_000)}\uFEFF\nFull output: local://1.log` }, media],
      details: { serverName: "fixture", mcpToolName: "sample", meta: { truncation: { artifactId: "1" } } },
    } };
    const compact = { type: "compaction", id: "compact", parentId: tool.id, timestamp,
      summary: "Reduced history", firstKeptEntryId: tool.id, tokensBefore: 12_000 };
    const unrelated = { type: "future_omp_annotation", id: "note", parentId: compact.id, timestamp,
      detail: "\uD800" }; // JSON permits even an isolated, escaped UTF-16 code unit.
    return titleSlot + [header, start, receipt, tool, compact, unrelated].map(line).join("");
  });
  expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(receipt).toEqual({ pid, ownerPid, sessionId, sessionFile, code: 0, workerAttempt: "fixture-attempt",
    signal: null, persisted: true, observationsFlushed: true });
  expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
});

const negativeCases: readonly {
  case: string;
  persisted: boolean;
  entries: (records: ReturnType<typeof rows>) => readonly Row[];
  first?: Row;
  tail?: string;
  overrides?: Readonly<Record<string, unknown>>;
}[] = [
  { case: "malformed JSON after all observations", persisted: false, entries: ({ start, receipt }) => [start, receipt], tail: "{broken}\n" },
  { case: "an illegal escape after an unpaired surrogate in a property name", persisted: false,
    entries: ({ start, receipt }) => [start, receipt], tail: String.raw`{"type":"message","\ud800\q":0}` + "\n" },
  { case: "nonhex digits in a property-name Unicode escape", persisted: false,
    entries: ({ start, receipt }) => [start, receipt], tail: String.raw`{"type":"message","\ud800\u12xz":0}` + "\n" },
  { case: "an unescaped control byte in a property name", persisted: false,
    entries: ({ start, receipt }) => [start, receipt], tail: '{"type":"message","bad\u0001key":0}\n' },
  { case: "a non-string property name", persisted: false,
    entries: ({ start, receipt }) => [start, receipt], tail: '{"type":"message",[]:0}\n' },
  { case: "a missing value for an opaque extension key", persisted: false,
    entries: ({ start, receipt }) => [start, receipt], tail: String.raw`{"type":"message","\ud800":}` + "\n" },
  { case: "a trailing object comma", persisted: false, entries: ({ start, receipt }) => [start, receipt], tail: '{"type":"message",}\n' },
  { case: "two records on the same physical line", persisted: false, entries: ({ start, receipt }) => [start, receipt],
    tail: '{"type":"message"} {"type":"message"}\n' },
  { case: "complete JSON without the closing newline", persisted: false, entries: ({ start, receipt }) => [start, receipt], tail: '{"type":"message"}' },
  { case: "a later matching header after a different header", persisted: false,
    first: { ...header, id: "other" }, entries: ({ start, receipt }) => [start, receipt, header] },
  { case: "a different header even when the run and receipt match", persisted: false,
    first: { ...header, id: "other" }, entries: ({ start, receipt }) => [start, receipt] },
  { case: "a missing run start", persisted: true, entries: ({ receipt }) => [receipt] },
  { case: "a duplicate run ordinal", persisted: true, entries: ({ start, receipt }) => [start, { ...start, id: "duplicate" }, receipt] },
  { case: "a result from another native instance", persisted: true,
    entries: ({ start, receipt }) => [start, { ...receipt, data: { ...receipt.data, instanceKey: "prior-instance" } }] },
  { case: "a partial result payload", persisted: true,
    entries: ({ start, receipt }) => [start, { ...receipt, data: { ...receipt.data, frame: { type: "prompt_result", status: "completed" } } }] },
  { case: "a result that substitutes parsed JSON for literal metadata", persisted: true,
    entries: ({ start, receipt }) => [start, { ...receipt, data: { ...receipt.data, frame: { ...frame, details: { sample: "draft" } } } }],
    overrides: { expectedObservations: [["result", literalFrame]] } },
  { case: "a result replaced by a spill link", persisted: true,
    entries: ({ start, receipt }) => [start, { ...receipt, data: { ...receipt.data, frame: "local://1.log" } }] },
  { case: "a previous flush failure even with all observations present", persisted: true,
    entries: ({ start, receipt }) => [start, receipt], overrides: { observationFailure: true } },
];

test.each(negativeCases)("exit proof fences $case", async ({ persisted, entries, first, tail, overrides }) => {
  const { result, receipt } = await exitFixture(
    records => [first ?? header, ...entries(records)].map(line).join("") + (tail ?? ""), overrides);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(receipt).toMatchObject({ persisted, observationsFlushed: false });
});

test("exit proof fails without publishing a receipt for a missing journal", async () => {
  const { result, receipt, sessionFile } = await exitFixture(() => null);
  expect(result.code).toBe(1);
  expect(receipt).toBeNull();
  expect(await Bun.file(sessionFile).exists()).toBe(false);
});

test("an exit receipt atomically replaces an old link without modifying its target", async () => {
  const sentinel = "untouched prior receipt target";
  const { result, receiptPath, receipt } = await exitFixture(
    ({ start, receipt }) => [header, start, receipt].map(line).join(""), {}, async (dir, path) => {
      const unrelated = join(dir, "old-target");
      await writeFile(unrelated, sentinel);
      await symlink(unrelated, path);
    });
  expect(result.code).toBe(0);
  expect((await lstat(receiptPath)).isFile()).toBe(true);
  expect(await readFile(join(dirname(receiptPath), "old-target"), "utf8")).toBe(sentinel);
  expect(receipt).toMatchObject({ persisted: true, observationsFlushed: true });
});

test("exit proof matches precisely the current launches and exact observation IDs and frames", async () => {
  const comparison = { ...frame, details: { latency: 1, values: [0, 1] } };
  const { result, receipt } = await exitFixture(({ start, receipt }) => [
    header,
    { ...start, data: { ...start.data, instanceKey: "previous-host" } },
    start,
    { ...start, id: "outside-run", data: { ...start.data, runOrdinal: 3 } },
    { ...start, id: "start-2", data: { ...start.data, runOrdinal: 2 } },
    { ...receipt, id: "stale", data: { ...receipt.data, frame: "local://1.log" } },
    { ...receipt, data: { ...receipt.data, frame: { ...comparison, details: { latency: 1, values: [1, 0] } } } },
    { ...receipt, data: { ...receipt.data, frame: { details: { values: [0, 1], latency: 1 }, ...frame } } },
    { ...receipt, id: "result-2", data: { ...receipt.data, frame: literalFrame, runOrdinal: 2 } },
  ].map(line).join("").replaceAll('"latency":1', '"latency":1.0'), {
    runOrdinal: 2, expectedObservations: [["result", comparison], ["result-2", literalFrame]], signal: "SIGTERM", code: null,
  });
  expect(result.code).toBe(0);
  expect(receipt).toMatchObject({ code: null, signal: "SIGTERM", persisted: true, observationsFlushed: true });
});
