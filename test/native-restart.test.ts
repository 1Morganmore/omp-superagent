import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isolatedNativeEnvironment, within } from "./fixtures/native-subprocess";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

for (const scenario of ["busy", "approval", "lane", "stop", "ack-interrupted", "settled-goal", "quarantine", "operator-stop", "lane-failure", "lane-abort",
  "lane-failure-recovery-window", "lane-abort-recovery-window"] as const) {
  nativeTest(`real native ${scenario} restart preserves ownership, recovery and replay boundaries`, async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "orn-"));
    await fs.chmod(root, 0o700);
    const home = path.join(root, "home");
    await fs.mkdir(home, { mode: 0o700 });
    const child = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", path.resolve(import.meta.dir, "fixtures/restart-native-proof.ts")],
      cwd: root,
      env: {
        ...isolatedNativeEnvironment(root),
        OMP_RESTART_NATIVE_ROOT: root,
        OMP_RESTART_NATIVE_SCENARIO: scenario,
        ...(process.env.OMP_TEST_COMMAND === undefined ? {} : { OMP_TEST_COMMAND: process.env.OMP_TEST_COMMAND }),
        ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
      },
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const [stdout, stderr, code] = await within(Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]), 240_000, `Native restart proof timed out; diagnostics retained at ${root}`);
      expect({ code, diagnostics: code === 0 ? "" : `${stdout}${stderr}\nRetained native restart proof: ${root}` })
        .toEqual({ code: 0, diagnostics: "" });
      process.stdout.write(stdout); // Emit the actual post-cleanup receipt and retained evidence URI.
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM"); // The owned orchestrator reaps its exact detached processes.
        await within(child.exited, 75_000, `Native restart cleanup timed out; retained ${root}`);
      }
    }
  }, 330_000);
}
