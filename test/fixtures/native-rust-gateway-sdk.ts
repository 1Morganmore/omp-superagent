/** Private fixture setup and stock OMP observation commands. */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostPaths, loadConfig, parseConfig } from "../../src/config/config";
import { requestIds } from "./native-request-envelope";
import { offlineMnemopi } from "./native-memory";

async function sdkMain(): Promise<void> {
  const root = process.env.OMP_TEST_HOST_FIXTURE_ROOT;
  assert(root && root === process.cwd() && process.env.HOME === join(root, "home")
    && process.env.PI_CODING_AGENT_DIR === join(root, "agent"), "Native Gateway SDK requires its private home");
  const configPath = join(root, "superagent.json");

  switch (process.argv[2]) {
    case "prepare": {
      const [{ nativeTestCommand }, { nativeDisabledProviders }] = await Promise.all([
        import("./native-command"), import("./native-extension"),
      ]);
      const native = await nativeTestCommand();
      const headCwd = join(root, "head");
      const agent = join(root, "agent");
      for (const directory of [headCwd, agent]) {
        await mkdir(directory, { mode: 0o700 });
        await chmod(directory, 0o700);
      }
      const model = "gateway-native/local";
      const modelRoles = { default: model, judge: model };
      await writeFile(join(agent, "config.yml"), JSON.stringify({
        ...offlineMnemopi,
        disabledProviders: nativeDisabledProviders, modelRoles,
        modelPresets: Object.fromEntries(["high", "middle", "low"].map(name => [name, { modelRoles }])),
      }), { mode: 0o600 });
      await writeFile(join(agent, "models.yml"), "providers: {}\n", { mode: 0o600 });
      // Share the same normalized Config as the operator CLI and its native launch.
      const config = parseConfig({
        stateDir: root, headCwd,
        command: [...native, "-e", join(import.meta.dir, "native-extension.ts"),
          "-e", join(import.meta.dir, "gateway-provider-extension.ts")],
        maxHosts: 2, maxSubagents: 2, idleMs: 3_600_000, model,
        discord: { tokenEnv: "ISOLATED_GATEWAY_DISCORD_TOKEN", ownerId: "1", allowedGuildIds: ["3"], allowedChannelIds: ["4"] },
      }, configPath);
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await writeFile(join(root, ".native-rust-gateway"), "offline-native-rust-gateway\n", { mode: 0o600, flag: "wx" });
      break;
    }
    case "snapshot": {
      const wanted = process.argv[3];
      assert(wanted === "streaming" || wanted === "settled");
      const paths = hostPaths(await loadConfig(configPath), "main");
      const { HostConnection } = await import("../../src/omp/host");
      const { connection, identity } = await HostConnection.open(paths.socketPath);
      const deadline = performance.now() + 10_000;
      try {
        for (;;) {
          const state = await connection.client.getState();
          const reached = wanted === "streaming" ? state.isStreaming && !state.isSettled
            : state.isSettled && !state.isStreaming && !state.isCompacting
              && !state.hasPendingAsyncWork && !state.hasOwnedRunningWork
              && state.queuedMessageCount === 0 && state.pendingUiRequests.length === 0;
          if (reached) {
            // Read actual stock selection and settings, never auth or endpoint data.
            console.log(JSON.stringify(process.argv[4] === "model" ? {
              head: identity, model: state.model ? { provider: state.model.provider, id: state.model.id } : null,
              configuredDefault: state.modelSettings.defaultThinkingLevel,
              configuredThinkingLevel: state.configuredThinkingLevel,
              modelSettings: state.modelSettings,
              thinkingLevel: { present: Object.hasOwn(state, "thinkingLevel"), value: state.thinkingLevel },
            } : identity));
            break;
          }
          assert(performance.now() < deadline, `Actual stock Host did not reach ${wanted}`);
          await Bun.sleep(25);
        }
      } finally { await connection.close(); }
      break;
    }
    case "transcript": {
      const paths = hostPaths(await loadConfig(configPath), "main");
      const { parseSessionEntries } = await import("@oh-my-pi/pi-coding-agent");
      const entries = parseSessionEntries(await readFile(paths.sessionFile, "utf8"));
      const requests = requestIds(entries);
      const shutdowns = entries.flatMap(entry => {
        if (entry.type !== "custom" || entry.customType !== "omp-superagent-native-test") return [];
        const data: unknown = entry.data;
        if (typeof data !== "object" || data === null || !("phase" in data) || data.phase !== "shutdown"
          || !("pid" in data) || !("sessionId" in data) || !("networkAttempts" in data)) return [];
        return [{ pid: data.pid, sessionId: data.sessionId, networkAttempts: data.networkAttempts }];
      });
      console.log(JSON.stringify({ requests, shutdowns }));
      break;
    }
    default: throw new Error("Unknown native Gateway SDK operation");
  }
}

if (import.meta.main) await sdkMain();
