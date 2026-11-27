import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "bun:test";
import { startHost } from "../src/omp/host";
import { fixtureHostLaunches, stopHostFixtures } from "./fixtures/host-fixture-processes";
import { nativeTestCommand } from "./fixtures/native-command";
import { nativeDisabledProviders } from "./fixtures/native-extension";
import { assertSameSession, configureIdleHead, waitForDormantHead } from "./fixtures/native-head-hibernation";
import { offlineMnemopi } from "./fixtures/native-memory";
import { until } from "./fixtures/native-rust-gateway";
import { ledger, meta, withNativeRustGateway } from "./fixtures/native-rust-gateway-assertions";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

nativeTest("the same agent directory cannot wake hibernated HEAD into a different XDG data partition", () =>
  withNativeRustGateway(async fixture => {
    // Stock OMP uses XDG for its default agent dir only when the data root
    // already exists. Keep the same agent-dir value for both launches.
    const agentDir = join(fixture.home, ".omp", "agent");
    const dataHome = join(fixture.root, "data");
    const alternateHome = join(fixture.root, "alternate-data");
    for (const directory of [agentDir, join(dataHome, "omp"), join(alternateHome, "omp")])
      await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const file of ["config.yml", "models.yml"]) await copyFile(join(fixture.root, "agent", file), join(agentDir, file));
    await configureIdleHead(fixture);
    const original = await fixture.ready(fixture.launchGateway(agentDir, dataHome));
    await waitForDormantHead(fixture, original);
    await fixture.crashGateway(original.gatewayPid);
    const sessions = join(dataHome, "omp", "sessions");
    const priorDirectory = (await readdir(sessions, { recursive: true })).sort();
    assert(priorDirectory.some(name => name.includes(original.head.sessionId)), "Original stock profile lacks the prepared journal link");

    const foreignGateway = fixture.launchGateway(agentDir, alternateHome);
    await until(async () => {
      const saved = ledger(fixture, db => meta(db, "gateway:socket"));
      if (!saved || JSON.parse(saved).pid !== foreignGateway) return;
      const status = await fixture.status();
      if (!status.head.error?.includes("Native HEAD profile changed")) return;
      assert.equal(status.head.hibernation?.stage, "sleeping");
      assert.equal(status.head.pid, null);
      assert.equal(status.gateway.admissionReady, false);
      return true;
    }, "wake refusal before foreign discovery publication");
    assert.equal((await fixtureHostLaunches(fixture.root)).length, 1);
    assert.equal(existsSync(join(alternateHome, "omp", "sessions")), false);
    assert.deepEqual((await readdir(sessions, { recursive: true })).sort(), priorDirectory);

    await fixture.crashGateway(foreignGateway);
    const resumed = await fixture.ready(fixture.launchGateway(agentDir, dataHome));
    assertSameSession(resumed.head, original.head);
    await fixture.stop(resumed);
  }), 120_000);

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

for (const change of ["dotenv", "symlink"] as const) {
  nativeTest(`stock Host refuses activation when ${change} redirects discovery after preparation`, async () => {
    const native = await nativeTestCommand();
    const root = await mkdtemp(join(await realpath("/tmp"), "osp-"));
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    const agentDir = join(home, ".omp", "agent");
    const dataHome = join(root, "initial-data");
    const alternateHome = join(root, "alternate-data");
    const alias = join(root, "data-alias");
    const dotenv = join(cwd, ".env");
    const executable = join(root, "stock");
    const changed = join(root, "changed");
    const socketPath = join(root, "lane.sock");
    const sessionFile = join(root, "session.jsonl");
    let succeeded = false;
    try {
      for (const dir of [cwd, agentDir, join(dataHome, "omp"), join(alternateHome, "omp")])
        await mkdir(dir, { recursive: true, mode: 0o700 });
      await symlink(dataHome, alias);
      await writeFile(dotenv, `XDG_DATA_HOME=${change === "symlink" ? alias : dataHome}\n`);
      await writeFile(join(agentDir, "config.yml"), JSON.stringify({ ...offlineMnemopi,
        disabledProviders: nativeDisabledProviders, eval: { js: false, py: false } }));
      const redirect = change === "dotenv"
        ? `printf '%s\\n' ${shellQuote(`XDG_DATA_HOME=${alternateHome}`)} > ${shellQuote(dotenv)}`
        : `/bin/rm ${shellQuote(alias)} && /bin/ln -s ${shellQuote(alternateHome)} ${shellQuote(alias)}`;
      await writeFile(executable, `#!/bin/sh
set -e
if [ -n "\${OMP_SUPERAGENT_NATIVE_SOCKET:-}" ]; then
  ${redirect}
  : > ${shellQuote(changed)}
fi
exec ${native.map(shellQuote).join(" ")} "$@"
`, { mode: 0o700 });

      await assert.rejects(() => startHost({
        command: [executable], cwd, sessionFile, socketPath, logPath: join(root, "native.log"),
        extensionPath: join(import.meta.dir, "fixtures/native-extension.ts"),
        managedUlwPath: join(import.meta.dir, "fixtures/managed-super"),
        model: "socket-host-smoke/local", subagentConcurrency: 1,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
          PI_CODING_AGENT_DIR: agentDir, PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1",
          TMPDIR: root, TMP: root, TEMP: root,
          OMP_TEST_HOST_FIXTURE_ROOT: root,
          XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
          ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
        },
      }), /OMP host (exited during startup|startup timed out)/);

      assert(existsSync(changed), "The stock child must hit the mutation after SDK preparation");
      assert.equal((await fixtureHostLaunches(root)).length, 1, "The real native extension must reach session startup");
      assert.equal(existsSync(socketPath), false, "The owner must never expose the mismatching native Host");
      const priorDirectory = await readdir(join(dataHome, "omp", "sessions"), { recursive: true, withFileTypes: true });
      assert.equal(priorDirectory.filter(entry => entry.isSymbolicLink()).length, 2, "Only the prepared root owns the journal and artifacts links");
      const foreignSessions = join(alternateHome, "omp", "sessions");
      if (existsSync(foreignSessions))
        assert(!(await readdir(foreignSessions, { recursive: true, withFileTypes: true })).some(entry => entry.isSymbolicLink()),
          "No staged journal or artifacts may enter the stock process's foreign roots");
      assert.doesNotMatch(await readFile(sessionFile, "utf8"), /"customType":"superagent_service_tracking"/);
      succeeded = true;
    } catch (cause) {
      throw new Error(`Native profile proof failed; retained private launch evidence: ${root}`, { cause });
    } finally {
      await stopHostFixtures(root);
      if (succeeded) await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
}
