import { expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { launchArgvHash, matchesPreparedLaunch } from "../src/omp/stock-head-launch";
import type { RotationSelection } from "../src/runtime/head-rotation";

const provider = "offline-fixture";
const modelId = "configured";
const defaultModel = `${provider}/${modelId}`;
const selection: RotationSelection = {
  provider, modelId, modelIdentity: defaultModel, reasoning: false, thinkingLevel: null, configuredThinkingLevel: null,
  modelSettings: { modelRoles: { default: defaultModel } },
  serviceTier: {}, serviceTierDefaults: {}, effectiveServiceTier: "none", stockLaunchReplay: true,
};
const helper = resolve(import.meta.dir, "../src/host-sdk-helper.ts");

async function withJournal(
  createEntries: (journal: SessionManager) => void,
  proof: (resume: (argv: readonly string[], live?: RotationSelection) => Promise<unknown>) => Promise<void>,
  editJournal?: (file: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sa-head-resume-"));
  try {
    const sessionFile = join(root, "head.jsonl");
    const journal = await SessionManager.open(sessionFile, root, undefined, { initialCwd: root, suppressBreadcrumb: true });
    const sessionId = journal.getSessionId();
    try {
      createEntries(journal);
      await journal.ensureOnDisk();
      journal.flushSync();
    } finally { await journal.close(); }
    await editJournal?.(sessionFile);
    const initial = await readFile(sessionFile);
    await proof(async (argv, live = selection) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", helper, "head-resume-command"], {
        cwd: root, env: { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, PATH: process.env.PATH },
        stdin: Buffer.from(JSON.stringify({ argv, selection: live, sessionFile, sessionId, checkJournal: true })),
        stdout: "pipe", stderr: "pipe", timeout: 5_000,
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exit, stderr).toBe(0);
      const payload = stdout.split("\n").find(line => line.startsWith("MANAGED_HEAD_RESUME "))?.slice("MANAGED_HEAD_RESUME ".length);
      if (payload === undefined) throw new Error("No native HEAD resume result");
      return JSON.parse(payload);
    });
    expect(await readFile(sessionFile)).toEqual(initial);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("HEAD resume refuses an ephemeral promoted model even without CLI selection flags", () =>
  withJournal(journal => {
    journal.appendModelChange(defaultModel);
    journal.appendModelChange(`${provider}/promoted`, EPHEMERAL_MODEL_CHANGE_ROLE);
  }, async resume => {
    const promoted: RotationSelection = {
      ...selection, modelId: "promoted", modelIdentity: `${provider}/promoted`,
      modelSettings: { modelRoles: { default: `${provider}/promoted` } },
    };
    expect(await resume([], promoted)).toHaveProperty("refused", expect.stringContaining("active model"));
    expect(await resume([])).toEqual({ command: [] });
  }));

test("HEAD can drop a launch model before the first turn only with an exact saved bootstrap default", () =>
  withJournal(() => {}, async resume => {
    const command = ["--model", defaultModel];
    expect(await resume(command, {
      ...selection, reasoning: true, thinkingLevel: "medium", configuredThinkingLevel: "auto",
    })).toEqual({ command: ["--thinking=auto"] });
    expect(await resume(command, { ...selection, modelId: "different", modelIdentity: `${provider}/different` }))
      .toHaveProperty("refused", expect.stringContaining("active model"));
  }));

test("HEAD resume leaves an operator-cleared service tier to the active stock journal branch", () =>
  withJournal(journal => {
    journal.appendModelChange(defaultModel);
    journal.appendServiceTierChange({ openai: "priority" });
    journal.appendServiceTierChange(null);
  }, async resume => {
    // The first identical token is the value of a different stock option.
    expect(await resume(["--system-prompt", "--service-tier", "--service-tier=priority"])).toEqual({
      command: ["--system-prompt", "--service-tier"],
    });
  }));

test("a service tier on a sibling journal branch cannot authorize removing a stopped restart override", () =>
  withJournal(journal => {
    const common = journal.appendModelChange(defaultModel);
    journal.appendServiceTierChange({ openai: "priority" });
    journal.branch(common);
    journal.appendThinkingLevelChange("off");
  }, async resume => {
    expect(await resume(["--service-tier", "priority"])).toHaveProperty("refused", expect.stringContaining("active journal branch"));
  }));

test("HEAD requires the branch's actual tier, including the native default when no tier was journaled", () =>
  withJournal(journal => {
    journal.appendModelChange(defaultModel);
  }, async resume => {
    const priority = { openai: "priority" } as const;
    expect(await resume([], { ...selection, serviceTier: priority }))
      .toHaveProperty("refused", expect.stringContaining("active service tier"));
    expect(await resume([], { ...selection, serviceTierDefaults: priority }))
      .toHaveProperty("refused", expect.stringContaining("active service tier"));
    expect(await resume([], { ...selection, serviceTier: priority, serviceTierDefaults: priority })).toEqual({ command: [] });
  }));

test("an explicit saved tier must match the live tier, not merely exist on the active branch", () =>
  withJournal(journal => {
    journal.appendModelChange(defaultModel);
    journal.appendServiceTierChange({ openai: "priority" });
  }, async resume => {
    expect(await resume(["--service-tier=priority"]))
      .toHaveProperty("refused", expect.stringContaining("active service tier"));
    expect(await resume(["--service-tier=flex"], { ...selection, serviceTier: { openai: "priority" } }))
      .toEqual({ command: [] });
  }));

test("a saved route authorizes only that upstream, not another upstream or the unrouted model", () => {
  const base = "openrouter/openai/test-model";
  const route = `${base}@together`;
  return withJournal(journal => {
    journal.appendModelChange(route);
  }, async resume => {
    const live = { ...selection, provider: "openrouter", modelId: "openai/test-model" };
    expect(await resume([], { ...live, modelIdentity: route })).toEqual({ command: [] });
    for (const modelIdentity of [base, `${base}@fireworks`]) {
      expect(await resume([], { ...live, modelIdentity }))
        .toHaveProperty("refused", expect.stringContaining("active model"));
    }
  });
});

test("a regular journal with a second session header cannot authorize sleep", () =>
  withJournal(journal => { journal.appendModelChange(defaultModel); }, async resume => {
    expect(await resume([])).toHaveProperty("refused", expect.stringContaining("competing native session header"));
  }, async sessionFile => {
    const header = (await readFile(sessionFile, "utf8")).split("\n").find(line => line.startsWith('{"type":"session"'));
    if (!header) throw new Error("Stock session fixture has no header");
    await appendFile(sessionFile, `${header}\n`);
  }));

test.each([
  { flag: "--max-time=2m", effect: "new deadline" },
  { flag: "--plan-yolo", effect: "rearms autonomous planning" },
  { flag: "--prewalk", effect: "rearms one-shot planning" },
  { flag: "--prewalk-into=@smol", effect: "rearms one-shot planning" },
])("HEAD refuses a fresh launch effect from $flag", ({ flag, effect }) =>
  withJournal(journal => { journal.appendModelChange(defaultModel); }, async resume => {
    expect(await resume([flag])).toHaveProperty("refused", expect.stringContaining(effect));
  }));

test.each([
  ["--fork=another"], ["--session", "another"], ["--resume=another"], ["-r"],
  ["--continue"], ["--restore"], ["--no-session"], ["--from-claude"], ["--from-codex"],
].map(argv => ({ argv })))("HEAD refuses a competing launch selector: $argv", ({ argv }) =>
  withJournal(() => {}, async resume => {
    expect(await resume(argv)).toHaveProperty("refused", expect.stringContaining("competing stock session selectors"));
    expect(await resume(["--system-prompt", argv[0]])).toEqual({ command: ["--system-prompt", argv[0]] });
  }));

test("a resident deadline makes stock replay unprovable even when an adopting command omits the flag", async () => {
  const file = "/private/head.jsonl";
  const suffix = ["--mode", "rpc-ui", "--session", file];
  const flags = new Map();
  const approved = launchArgvHash(suffix);
  expect(matchesPreparedLaunch(suffix, approved, flags)).toBe(true);
  expect(matchesPreparedLaunch(["--max-time=2m", ...suffix], approved, flags)).toBe(false);
  expect(matchesPreparedLaunch(suffix, approved, new Map([["session", {}]]))).toBe(false);
  await withJournal(journal => { journal.appendModelChange(defaultModel); }, async resume => {
    const { stockLaunchReplay: _unproved, ...unproved } = selection;
    expect(await resume([], unproved)).toHaveProperty("refused", expect.stringContaining("actual stock launch"));
  });
});
