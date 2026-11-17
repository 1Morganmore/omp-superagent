import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { Inbound } from "../src/contracts";
import type { PrSnapshot } from "../src/pr-github";
import { PrWatcher } from "../src/pr-watch";
import { Store } from "../src/store";

const fixtures: Array<{ store: Store; directory: string }> = [];
afterEach(() => {
  for (const { store, directory } of fixtures.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
const base: PrSnapshot = { head: "a".repeat(40), state: "open", mergedSha: null, self: "owner",
  feedback: [], failures: [], headChange: "unknown" };
const feedback = (key: string, actor = "reviewer") => ({
  key, actor, kind: "review", url: "https://github.com/example/project/pull/7#discussion_r1", text: `Feedback ${key}`,
});
function fixture() {
  const directory = mkdtempSync("/tmp/sa-pr-watch-");
  const config: Config = { path: join(directory, "config.json"), stateDir: directory, headCwd: directory,
    command: [process.execPath], maxHosts: 2, maxSubagents: 4, idleMs: 1000,
    discord: { tokenEnv: "UNUSED", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] } };
  const store = new Store(join(directory, "coordination.sqlite"));
  const input: Inbound = { id: "source", messageId: "123", text: "Follow this PR", receivedAt: 1, attachments: [],
    route: { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: "5" } };
  store.receive(input, "main", { "user-source:source": "true" });
  store.settle(input.id, "done");
  const observed = { snapshot: base, calls: 0, failure: false };
  const read = async () => {
    observed.calls++;
    if (observed.failure) throw new Error("GitHub read failed");
    return observed.snapshot;
  };
  const watcher = new PrWatcher(store, config, read);
  const command = { action: "track" as const, sourceId: input.id, ref: "example/project#7", intervalSeconds: 1 };
  watcher.change(command);
  fixtures.push({ store, directory });
  const signal = new AbortController().signal;
  return { store, config, input, observed, watcher, read, command, signal };
}

test("baseline is quiet and new reviews and CI reruns are durable original-route HEAD observations", async () => {
  const f = fixture();
  f.observed.snapshot = { ...base, feedback: [feedback("old")] };
  await f.watcher.poll(1000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(0);
  f.observed.snapshot = { ...base, feedback: [feedback("old"), feedback("new"), feedback("own", "owner")],
    failures: [{ key: "check:1:run1", name: "tests", conclusion: "failure", url: "https://github.com/example/project/actions/runs/1" }] };
  await f.watcher.poll(2000, f.signal);
  const [event] = f.store.inputs("main");
  expect(event?.route).toEqual(f.input.route);
  expect(event?.messageId).toBe("123");
  expect(event?.text).toContain("Feedback new");
  expect(event?.text).not.toContain("Feedback old");
  expect(event?.text).not.toContain("Feedback own");
  expect(event?.text).toContain("PR_CI_FAIL");
  expect(event && f.store.getMeta(`user-source:${event.id}`)).toBeNull();
  await new PrWatcher(f.store, f.config, f.read).poll(3000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(1);
  f.observed.snapshot = { ...f.observed.snapshot, failures: [{ key: "check:1:run2", name: "tests",
    conclusion: "failure", url: "https://github.com/example/project/actions/runs/1" }] };
  await f.watcher.poll(4000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(2);
});

test("self pushes do not wake HEAD but external changes and repeated close/reopen do", async () => {
  const f = fixture();
  await f.watcher.poll(0, f.signal);
  f.observed.snapshot = { ...base, head: "b".repeat(40), headChange: "self" };
  await f.watcher.poll(1000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(0);
  f.observed.snapshot = { ...base, headChange: "rewritten" };
  await f.watcher.poll(2000, f.signal);
  expect(f.store.inputs("main")[0]?.text).toContain("PR_HEAD_MOVED");
  for (const [index, state] of (["closed", "open", "closed", "open"] as const).entries()) {
    f.observed.snapshot = { ...base, state };
    await f.watcher.poll(3000 + index * 1000, f.signal);
  }
  expect(f.store.inputs("main")).toHaveLength(5);
  f.observed.snapshot = { ...base, state: "merged", mergedSha: "c".repeat(40) };
  await f.watcher.poll(7000, f.signal);
  const calls = f.observed.calls;
  await f.watcher.poll(8000, f.signal);
  expect(f.observed.calls).toBe(calls);
  expect(f.store.inputs("main").at(-1)?.text).toContain("PR_MERGED");
});

test("failed observations preserve the baseline, notify once and recover without losing later feedback", async () => {
  const f = fixture();
  await f.watcher.poll(0, f.signal);
  f.observed.failure = true;
  await f.watcher.poll(1000, f.signal);
  await f.watcher.poll(2000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(1);
  expect(f.watcher.list()[0]?.baseline?.head).toBe(base.head);
  f.observed.failure = false;
  f.observed.snapshot = { ...base, feedback: [feedback("later")] };
  await f.watcher.poll(3000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(2);
  expect(f.watcher.list()[0]?.error).toBeNull();
});

test("tracking mutations are source-bound and an old retry cannot re-enable an untracked PR", () => {
  const f = fixture();
  const epoch = f.watcher.list()[0]?.epoch;
  f.watcher.change(f.command);
  expect(f.watcher.list()[0]?.epoch).toBe(epoch);
  expect(() => f.watcher.change({ ...f.command, intervalSeconds: 2 })).toThrow("identity conflict");
  f.watcher.change({ action: "untrack", sourceId: "source", ref: f.command.ref });
  f.watcher.change(f.command);
  expect(f.watcher.list()).toHaveLength(0);
  expect(() => f.watcher.change({ ...f.command, sourceId: "missing" })).toThrow("authorized user source");
});

test("untrack during a slow read cannot write a stale cursor or deliver feedback", async () => {
  const f = fixture();
  await f.watcher.poll(0, f.signal);
  const pending = Promise.withResolvers<PrSnapshot>();
  const watcher = new PrWatcher(f.store, f.config, () => pending.promise);
  const poll = watcher.poll(1000, f.signal);
  watcher.change({ action: "untrack", sourceId: "source", ref: f.command.ref });
  pending.resolve({ ...base, feedback: [feedback("late")] });
  await poll;
  expect(watcher.list()).toHaveLength(0);
  expect(f.store.inputs("main")).toHaveLength(0);
});

test("head stop during a read durably holds watches until a new explicit registration", async () => {
  const f = fixture();
  await f.watcher.poll(0, f.signal);
  const pending = Promise.withResolvers<PrSnapshot>();
  const watcher = new PrWatcher(f.store, f.config, () => pending.promise);
  const poll = watcher.poll(1000, f.signal);
  f.store.setMeta("head:stop-boundary", JSON.stringify({ inputId: "stop", cancelledInputIds: [] }));
  pending.resolve({ ...base, feedback: [feedback("late")] });
  await poll;
  expect(watcher.list()[0]?.held).toBe(true);
  const restored = new PrWatcher(f.store, f.config, f.read);
  await restored.poll(2000, f.signal);
  expect(f.observed.calls).toBe(1);
  expect(f.store.inputs("main")).toHaveLength(0);
  f.store.receive({ ...f.input, id: "resume", messageId: "124" }, "main", { "user-source:resume": "true" });
  restored.change({ ...f.command, sourceId: "resume" });
  expect(restored.list()[0]?.held).toBe(false);
});

test("changing the allowed route prevents network observation", async () => {
  const f = fixture();
  f.config.discord = { tokenEnv: "UNUSED", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["999"] };
  await f.watcher.poll(0, f.signal);
  expect(f.observed.calls).toBe(0);
  expect(f.watcher.list()).toHaveLength(0);
  expect(() => f.watcher.change({ ...f.command, ref: "example/project#8" })).toThrow("authorized user source");
});

test("aborted observation does not persist a cursor or emit an error wake", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<PrSnapshot>();
  const controller = new AbortController();
  const watcher = new PrWatcher(f.store, f.config, () => pending.promise);
  const poll = watcher.poll(0, controller.signal);
  controller.abort();
  pending.resolve(base);
  await poll;
  expect(watcher.list()[0]?.baseline).toBeNull();
  expect(f.store.inputs("main")).toHaveLength(0);
});

test("a failed atomic admission leaves feedback eligible on the next pass", async () => {
  const f = fixture();
  await f.watcher.poll(0, f.signal);
  f.observed.snapshot = { ...base, feedback: [feedback("new")] };
  const receive = f.store.receive.bind(f.store);
  f.store.receive = () => { throw new Error("Admission failed"); };
  await expect(f.watcher.poll(1000, f.signal)).rejects.toThrow("Admission failed");
  f.store.receive = receive;
  await f.watcher.poll(1000, f.signal);
  expect(f.store.inputs("main")).toHaveLength(1);
  expect(f.store.inputs("main")[0]?.text).toContain("Feedback new");
});

test("damaged cursor never silently becomes a fresh baseline", async () => {
  const f = fixture();
  f.store.setMeta("pr-watch:v1", '{"watches":[]}');
  await expect(f.watcher.poll(0, f.signal)).rejects.toThrow("damaged");
  expect(f.observed.calls).toBe(0);
});
