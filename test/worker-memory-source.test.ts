import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import { managedUlwLaunch } from "../src/omp/managed-super";
import { parseWorkerMemoryPage } from "../src/worker/worker-memory-page";
import { canBeginWorkerFact, isWorkerFactRoot, nativeFactSuccess, reserveWorkerFactProofs, sameWorkerFactEntry, sameWorkerFactResult,
  workerFactBatch, workerFactDigest, workerFactEntry, workerFactProofs, workerFactResult } from "../src/worker/worker-memory-proofs";
import { readWorkerMemoryPage } from "../src/worker/worker-memory-source";
import { prepareWorkerMemory, workerMemoryPaths, type WorkerMemoryBinding } from "../src/worker/worker-memory-storage";
import { workerMemoryCheckoutStamp, workerMemoryRepositoryMatches, workerRepositoryIdentity } from "../src/worker/worker-repository";

const origin = { bank: "fixture-project", cwd: "/fixture/project", sessionId: "native-root-id",
  bankFile: "1:2", attempt: "first-attempt" };
const bankKey = "00000000-0000-4000-8000-000000000000";
const fixtureCheckout = (repoRoot: string) => ({ repoRoot, gitDir: join(repoRoot, ".git"),
  repoId: "a".repeat(64), revision: "b".repeat(40), subdir: "" });
const exampleBot = `000000001:AA${"fake_".repeat(7)}`;
const exampleDiscord = `${Buffer.from("000000000000000001").toString("base64url")}.FAKE00.${"fake".repeat(8)}`;
const messagingSecrets = [
  `https://api.telegram.org/bot${exampleBot}/getMe`,
  `https://api.telegram.org/file/bot${exampleBot.replace(":", "%3A")}/photos/not-real.png`,
  "https://telegram-proxy.invalid/bot000000001%3Anot-real/getMe",
  exampleBot,
  `https://discord.com/api/v10/%77ebhooks/000000001/${"fake".repeat(10)}`,
  "xapp-1-FAKEFIXTURE-000000000000",
  "https://hooks.slack.com/services/FIXTURE/NOT/real",
  "https://hooks.slack.com/commands/FIXTURE/NOT/real",
  "https://hooks.slack-gov.com/%73ervices/FIXTURE/NOT/real",
  `Authorization: Bot ${exampleDiscord}`,
  `Bot ${exampleDiscord}`,
  exampleDiscord,
  "Request Cookie: fixture_ticket=synthetic-no-known-prefix",
  "Response sEt-CooKie : fixture_ticket=synthetic-no-known-prefix; HttpOnly",
];

function nativeMemory(onDisk = false) {
  const dir = mkdtempSync(join(realpathSync("/tmp"), "worker-memory-"));
  const path = join(dir, "native.db");
  const dbPath = onDisk ? path : ":memory:";
  const memory = new Mnemopi({ dbPath, bank: origin.bank, sessionId: origin.bank, channelId: origin.bank,
    authorId: "coding-agent", authorType: "agent", noEmbeddings: true, llm: false, reconcile: false });
  const proofsPath = join(dir, "fact-proofs.sqlite");
  const proofIdentity = reserveWorkerFactProofs(proofsPath);
  return { memory, path, proofsPath, proofIdentity, binding: { ...origin, proofs: workerFactProofs(proofsPath, proofIdentity) },
    [Symbol.dispose]() {
      try { memory.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
    } };
}

function retain({ memory, binding }: ReturnType<typeof nativeMemory>, content: string, tool: "retain" | "learn" = "retain",
  overrides: Parameters<Mnemopi["remember"]>[1] = {}, witnessed = true) {
  if (witnessed) binding.proofs.seal([workerFactDigest(binding, tool, content)]);
  return memory.remember(content, { source: `coding-agent-${tool}`, scope: "bank", veracity: "tool", memoryType: "fact",
    metadata: { tool, cwd: origin.cwd, session_id: origin.sessionId, context: "must not leave the worker" }, ...overrides });
}

test("reads only live native retain/learn rows with the exact root and project origin", async () => {
  using fixture = nativeMemory();
  const { memory, binding } = fixture;
  const keep = retain(fixture, "Builds use a platform-specific cache.");
  const learned = retain(fixture, "Use the existing serialization order.", "learn");
  retain(fixture, "Unrelated root note", "retain", { metadata: { tool: "retain", cwd: origin.cwd, session_id: "child", context: null } });
  retain(fixture, "Unrelated project note", "retain", { metadata: { tool: "retain", cwd: "/foreign", session_id: origin.sessionId, context: null } });
  retain(fixture, "Spoofed retain tool origin", "learn", { metadata: { tool: "retain", cwd: origin.cwd, session_id: origin.sessionId, context: null } });
  retain(fixture, "Not project scope", "retain", { scope: "global" });
  retain(fixture, "Transcript sample", "retain", { source: "coding-agent-transcript", memoryType: "episode" });
  const retired = retain(fixture, "An obsolete specific note");
  expect(memory.beam.invalidate(retired, keep)).toBe(true);
  retain(fixture, "Authorization: Bearer fixture-bearer");
  retain(fixture, "https://download.example/file?signature=fixture");
  for (const secret of messagingSecrets) retain(fixture, secret);
  retain(fixture, "secret\x00control");
  retain(fixture, "x".repeat(2049));
  retain(fixture, "Native metadata without root proof", "retain", {}, false);

  await memory.flushExtractions();
  const page = readWorkerMemoryPage(memory, binding, { after: 0 });
  expect(page).toEqual({ after: 0, next: 0, stamp: expect.stringMatching(/^[0-9a-f]{64}$/),
    records: [
      { at: 1, id: keep, content: "Builds use a platform-specific cache." },
      { at: 2, id: learned, content: "Use the existing serialization order." },
    ] });
});

test("scan work is capped even when every candidate is ineligible; wrapped reads revisit recycled rowids", async () => {
  using fixture = nativeMemory();
  const { memory, binding } = fixture;
  for (let i = 0; i < 65; i++) memory.remember(`Conversation ${i}`);
  const original = retain(fixture, "Retained after ineligible rows.");
  await memory.flushExtractions();
  const first = readWorkerMemoryPage(memory, binding, { after: 0 });
  expect(first).toEqual({ after: 0, next: 64, records: [], stamp: first.stamp });
  const final = readWorkerMemoryPage(memory, binding, { after: first.next });
  expect(final).toEqual({
    after: 64, next: 0, stamp: first.stamp,
    records: [{ at: 66, id: original, content: "Retained after ineligible rows." }],
  });
  expect(readWorkerMemoryPage(memory, binding, { after: 0, unchanged: final.stamp }))
    .toEqual({ after: 0, next: 0, records: [], stamp: final.stamp });
  expect(memory.forget(original)).toBe(true);
  const replacement = retain(fixture, "A new fact at the reused rowid.");
  await memory.flushExtractions();
  const changed = readWorkerMemoryPage(memory, binding, { after: 0, unchanged: final.stamp });
  expect(changed.stamp).not.toBe(final.stamp);
  expect(readWorkerMemoryPage(memory, binding, { after: changed.next }).records)
    .toEqual([{ at: 66, id: replacement, content: "A new fact at the reused rowid." }]);
});

test("memory pages refuse pending native writes and notice external SQLite commits", async () => {
  using fixture = nativeMemory(true);
  const { memory, path, binding } = fixture;
  const id = retain(fixture, "An existing fact.");
  await memory.flushExtractions();
  const before = readWorkerMemoryPage(memory, binding, { after: 0 });
  const pending = Promise.resolve();
  memory.beam.pendingExtractions.add(pending);
  expect(() => readWorkerMemoryPage(memory, binding, { after: 0, unchanged: before.stamp })).toThrow("unavailable");
  memory.beam.pendingExtractions.delete(pending);
  using second = new Database(path);
  second.query("UPDATE working_memory SET content = ? WHERE id = ?").run("An updated fact.", id);
  const after = readWorkerMemoryPage(memory, binding, { after: 0, unchanged: before.stamp });
  expect(after.stamp).not.toBe(before.stamp);
  expect(after.records).toEqual([]);
});

test("a record limit does not skip the candidate that did not fit", async () => {
  using fixture = nativeMemory();
  const { memory, binding } = fixture;
  const ids = Array.from({ length: 17 }, (_, i) => retain(fixture, `Native project note ${i}.`));
  await memory.flushExtractions();
  const page = readWorkerMemoryPage(memory, binding, { after: 0 });
  expect(page.next).toBe(16);
  expect(page.records.map(record => record.id)).toEqual(ids.slice(0, 16));
  const final = readWorkerMemoryPage(memory, binding, { after: page.next });
  expect(final.next).toBe(0);
  expect(final.records.map(record => record.id)).toEqual(ids.slice(16));
});

test("native memory_edit cannot republish changed text under the old native creation metadata", async () => {
  using fixture = nativeMemory();
  const { memory, binding, proofsPath, proofIdentity } = fixture;
  const original = "The project keeps its native wire fixtures.";
  const id = retain(fixture, original);
  await memory.flushExtractions();
  expect(readWorkerMemoryPage(memory, binding, { after: 0 }).records).toEqual([{ at: 1, id, content: original }]);
  const before = memory.beam.db.query("SELECT metadata_json FROM working_memory WHERE id = ?").get(id);
  expect(memory.update(id, "An arbitrary replacement under the same native ID.")).toBe(true);
  await memory.flushExtractions();
  expect(memory.beam.db.query("SELECT metadata_json FROM working_memory WHERE id = ?").get(id)).toEqual(before);
  const reopened = { ...binding, proofs: workerFactProofs(proofsPath, proofIdentity) };
  expect(readWorkerMemoryPage(memory, reopened, { after: 0 }).records).toEqual([]);
  expect(memory.update(id, original)).toBe(true);
  await memory.flushExtractions();
  expect(readWorkerMemoryPage(memory, reopened, { after: 0 }).records).toEqual([{ at: 1, id, content: original }]);
});

test("proof digests bind exact native input, and never include context, partial or skill payloads", () => {
  const first = { content: "Project builds use existing scripts.", context: "Leave this behind." };
  const second = { content: "Project tests use frozen fixtures." };
  const batch = workerFactBatch(origin, "retain", { items: [first, second] });
  expect(batch).toEqual(workerFactBatch(origin, "retain", { items: [{ ...first, context: "different context" }, second] }));
  expect(batch).not.toEqual(workerFactBatch(origin, "retain", { items: [second, first] }));
  expect(nativeFactSuccess("retain", { count: 1 }, 2)).toBe(false);
  expect(nativeFactSuccess("retain", { count: 2 }, 2)).toBe(true);
  expect(workerFactBatch(origin, "learn", { memory: first.content, skill: {} })).toBeUndefined();
  expect(workerFactBatch(origin, "learn", { memory: first.content, scope: "global" })).toBeUndefined();
  expect(workerFactBatch(origin, "learn", { memory: first.content })).toEqual([workerFactDigest(origin, "learn", first.content)]);
  expect(nativeFactSuccess("learn", { skill: null }, 1)).toBe(true);
});

test("mounted retain uses a foreground native execution receipt, never Bash output, help or partial results", () => {
  const content = "The fixture keeps its existing build directory.";
  const args = { items: [{ content }] };
  const input = { command: `retain --json '${JSON.stringify(args)}'` };
  expect(canBeginWorkerFact("bash", input)).toBe(true);
  expect(canBeginWorkerFact("bash", { command: "git status" })).toBe(false);
  expect(canBeginWorkerFact("bash", { command: "retain --help" })).toBe(false);
  const entry = workerFactEntry(origin, "bash", input);
  if (!entry) throw new Error("Mountable retain entry was not recognized");
  const dispatch = { tool: "retain", mode: "execute", exitCode: 0, tier: "read", args, inner: { count: 1 } };
  const digest = workerFactDigest(origin, "retain", content);
  expect(workerFactResult(origin, entry, { toolCommands: [dispatch] })).toEqual([digest]);
  const different = workerFactEntry(origin, "bash", { command: ` ${input.command}` });
  expect(different && sameWorkerFactEntry(entry, different)).toBe(false);
  expect(sameWorkerFactResult([digest], workerFactResult(origin, entry, { toolCommands: [
    { ...dispatch, args: { items: [{ content: "Another fact." }] } },
  ] }))).toBe(false);
  expect(workerFactEntry(origin, "bash", { command: "retain --help" })).toBeUndefined();
  expect(workerFactEntry(origin, "bash", { command: `echo '${JSON.stringify({ toolCommands: [dispatch] })}'` })).toBeUndefined();
  expect(workerFactEntry(origin, "bash", { command: `${input.command}; git checkout fixture` })).toBeUndefined();
  expect(workerFactEntry(origin, "bash", { command: "retain --json \"$(cat fixture.json)\"" })).toBeUndefined();
  for (const command of ["learn --memory @notes.txt", "learn --memory='@'notes.txt",
    "retain --json \\@facts.json", "retain --json='-'", "learn --memory '-'"])
    expect(workerFactEntry(origin, "bash", { command })).toBeUndefined();
  expect(workerFactEntry(origin, "bash", { ...input, async: true })).toBeUndefined();
  for (const details of [
    { content: [{ type: "text", text: JSON.stringify({ toolCommands: [dispatch] }) }] },
    { toolCommands: [{ ...dispatch, mode: "help" }] },
    { toolCommands: [{ ...dispatch, exitCode: 1 }] },
    { toolCommands: [{ ...dispatch, tier: "write" }] },
    { toolCommands: [{ ...dispatch, inner: { count: 0 } }] },
    { toolCommands: [dispatch], async: { state: "running" } },
    { toolCommands: [dispatch], exitCode: 1 },
  ]) expect(workerFactResult(origin, entry, details)).toBeUndefined();
});

test("mounted fact evidence belongs to the exact stock root, not a child, advisor or detached capture", () => {
  const sessionManager = {};
  const main = { kind: "main", id: "Main" };
  expect(isWorkerFactRoot({ agent: main, sessionManager }, main.id, sessionManager)).toBe(true);
  for (const agent of [{ kind: "main", id: "capture" }, { kind: "sub", id: "advisor" }, { kind: "sub", id: main.id }])
    expect(isWorkerFactRoot({ agent, sessionManager }, main.id, sessionManager)).toBe(false);
  expect(isWorkerFactRoot({ agent: main, sessionManager: {} }, main.id, sessionManager)).toBe(false);
});

test("private proof lookup rejects same-inode schema changes and a replacement with the correct schema", () => {
  using fixture = nativeMemory();
  const { binding, proofsPath } = fixture;
  {
    using edit = new Database(proofsPath);
    edit.exec("DROP INDEX worker_fact_proofs_digest;");
  }
  expect(() => binding.proofs.lookup()).toThrow("schema");
  renameSync(proofsPath, `${proofsPath}.original`);
  reserveWorkerFactProofs(proofsPath);
  expect(() => binding.proofs.lookup()).toThrow("unavailable");
});

test("the strict page parser refuses foreign fields, control and credential values, and an oversized wire page", () => {
  const stamp = "a".repeat(64);
  const id = "0123456789abcdef";
  const record = { at: 2, id, content: "A valid fact." };
  const page = { after: 1, next: 0, stamp, records: [record] };
  expect(parseWorkerMemoryPage(page, 1)).toEqual(page);
  for (const invalid of [
    { ...page, next: 1 }, { ...page, stamp: "foreign" }, { ...page, path: "/private/bank" },
    ...[...messagingSecrets, "Bearer small-token", "ssh://worker@example.com/project", "https://example.com/path?X-Amz-Signature=fixture",
      "https://user:pass@example.com/path", "secret=fixture", "line\nbreak"].map(content => ({ ...page, records: [{ ...record, content }] })),
    { ...page, records: Array.from({ length: 16 }, (_, i) => ({ at: i + 2, id: i.toString(16).padStart(16, "0"), content: '"'.repeat(2048) })) },
  ]) expect(() => parseWorkerMemoryPage(invalid, 1)).toThrow();
});

test("the opted-in lane restores its original physical bank without mutating any native settings except dbPath", () => {
  const dir = mkdtempSync(join(realpathSync("/tmp"), "worker-memory-"));
  try {
    const launch = { cwd: dir, sessionFile: join(dir, "lane", "session.jsonl") };
    mkdirSync(join(dir, "lane"), { mode: 0o700 });
    const request = { key: bankKey, checkout: fixtureCheckout(dir) };
    const profile = { version: 2, agentDir: dir, dataDir: dir, sessionsDir: dir } as const;
    const plan = { profile, bank: origin.bank };
    const first = prepareWorkerMemory(request, launch, plan);
    const { dbPath, base } = workerMemoryPaths({ key: request.key, bank: plan.bank, sessionFile: launch.sessionFile });
    expect(first.config).toEqual({ mnemopi: { dbPath: base } });
    expect(prepareWorkerMemory({ ...request, previous: first.binding }, launch, plan)).toEqual(first);
    expect(() => prepareWorkerMemory({ ...request, previous: first.binding }, launch,
      { ...plan, profile: { ...profile, agentDir: "/other-agent" } })).toThrow("profile");
    symlinkSync(dbPath, `${dbPath}-wal`);
    expect(() => prepareWorkerMemory({ ...request, previous: first.binding }, launch, plan)).toThrow("non-private");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("worker launch discovery opts in only the effective native per-project Mnemopi profile", async () => {
  const root = mkdtempSync(join(realpathSync("/tmp"), "worker-memory-"));
  try {
    const discover = async (backend: "local" | "mnemopi", scoping: "per-project" | "global", previous?: WorkerMemoryBinding) => {
      const home = join(root, `${backend}-${scoping}`);
      const cwd = join(home, "project");
      const agent = join(home, "agent");
      for (const dir of [home, cwd, agent]) mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(agent, "config.yml"), JSON.stringify({ memory: { backend }, mnemopi: { scoping } }));
      const configPath = join(home, "host.json");
      writeFileSync(configPath, "{}");
      const { composition } = await managedUlwLaunch({
        cwd, configPath, managedUlwPath: join(import.meta.dir, "fixtures", "managed-super"),
        extensionPaths: [], commandArgs: [], launchArgs: ["--mode", "rpc-ui", "--cwd", cwd, "--no-extensions",
          "--no-lsp", "--config", configPath],
        env: { HOME: home, PI_CODING_AGENT_DIR: agent, PATH: "/usr/bin:/bin" }, bunCommand: [process.execPath, "--no-env-file"],
        worker: { extensionPaths: [], memory: { key: bankKey, checkout: fixtureCheckout(cwd), previous } },
      });
      return composition;
    };
    const [isolated, shared, local] = await Promise.all([
      discover("mnemopi", "per-project"), discover("mnemopi", "global"), discover("local", "per-project"),
    ]);
    expect(isolated.workerMemory?.bank).toStartWith("project-");
    expect(isolated.workerMemory?.profile.agentDir).toEndWith("/mnemopi-per-project/agent");
    expect(shared.workerMemory).toBeUndefined();
    expect(local.workerMemory).toBeUndefined();
    const dormant = await discover("local", "global", { key: bankKey, bank: origin.bank, profile: "a".repeat(64), file: "1:2" });
    expect(dormant.workerMemoryDormant).toBe(true);
    expect(dormant.workerMemory).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, { timeout: 15_000 });

test("memory identity checks catch worker checkout drift without treating dirty tracked files as a new checkout", async () => {
  const root = mkdtempSync(join(realpathSync("/tmp"), "worker-memory-"));
  const cwd = join(root, "sub");
  const git = (...args: readonly string[]) => execFileSync("/usr/bin/git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  try {
    git("init", "-q");
    git("remote", "add", "origin", "https://example.invalid/fixture/repo.git");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "file.txt"), "first\n");
    git("add", "--all");
    const commit = () => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture");
    commit();
    const repoId = await workerRepositoryIdentity(cwd);
    if (!repoId) throw new Error("Fixture repository identity is unavailable");
    const expected = { repoRoot: root, gitDir: join(root, ".git"), subdir: "sub", repoId, revision: git("rev-parse", "HEAD") };
    writeFileSync(join(cwd, "file.txt"), "dirty local edits\n");
    expect(await workerMemoryRepositoryMatches(cwd, expected)).toBe(true);
    const beforeOriginChange = workerMemoryCheckoutStamp(cwd, expected);
    expect(beforeOriginChange).toBeTruthy();
    git("remote", "set-url", "origin", "https://example.invalid/fixture/unrelated.git");
    expect(await workerMemoryRepositoryMatches(cwd, expected)).toBe(false);
    git("remote", "set-url", "origin", "https://example.invalid/fixture/repo.git");
    expect(await workerMemoryRepositoryMatches(cwd, expected)).toBe(true);
    const beforeCommit = workerMemoryCheckoutStamp(cwd, expected);
    expect(beforeCommit).not.toBe(beforeOriginChange);
    git("add", "--all");
    commit();
    expect(await workerMemoryRepositoryMatches(cwd, expected)).toBe(false);
    const newer = git("rev-parse", "HEAD");
    git("update-ref", "HEAD", expected.revision, newer);
    expect(await workerMemoryRepositoryMatches(cwd, expected)).toBe(true);
    expect(workerMemoryCheckoutStamp(cwd, expected)).not.toBe(beforeCommit);
    const renamed = join(root, "renamed");
    renameSync(cwd, renamed);
    symlinkSync(renamed, cwd);
    expect(await workerMemoryRepositoryMatches(cwd, { ...expected, revision: git("rev-parse", "HEAD") })).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
