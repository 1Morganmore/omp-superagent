import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stopHostFixtures } from "./host-fixture-processes";
import { isolatedNativeEnvironment, within } from "./native-subprocess";

type NativeGatewayProof = {
  readonly name: "Gateway" | "ULW";
  readonly script: "native-gateway.ts" | "native-chat-observation.ts";
  readonly scenarioEnv: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  readonly assertStdout?: (stdout: string) => void;
  readonly assertHostCount: (count: number, root: string) => void;
};

async function stopFixture(child: Bun.Subprocess, name: NativeGatewayProof["name"]): Promise<void> {
  if (child.exitCode !== null) { await child.exited; return; }
  child.kill("SIGTERM"); // Let the fixture close its Gateway and exact recorded hosts.
  await within(child.exited, 75_000, `Native ${name} fixture cleanup timed out`).catch(async () => {
    child.kill("SIGKILL"); // Only the exact spawned fixture.
    await within(child.exited, 5_000, `Owned native ${name} fixture did not exit after SIGKILL`);
  });
}

export async function runNativeGatewayProof({
  name, script, scenarioEnv, assertStdout, assertHostCount,
}: NativeGatewayProof): Promise<void> {
  const root = await mkdtemp(join(await realpath("/tmp"), name === "Gateway" ? "osg-" : "osu-"));
  await chmod(root, 0o700);
  let hostCount: number;
  try {
    const overrides = await scenarioEnv();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    // Native imports and subprocesses begin only after HOME/settings isolation.
    const child = Bun.spawn({
      cmd: [process.execPath, resolve(import.meta.dir, script)],
      cwd: root,
      env: {
        OMP_TEST_HOST_FIXTURE_ROOT: root,
        ...isolatedNativeEnvironment(root),
        OMP_NATIVE_GATEWAY_ROOT: root,
        ...(process.env.OMP_TEST_COMMAND === undefined ? {} : { OMP_TEST_COMMAND: process.env.OMP_TEST_COMMAND }),
        ...(process.env.OMP_TEST_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.OMP_TEST_NATIVES_DIR } : {}),
        ...overrides,
      },
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const [stdout, stderr, code] = await within(Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]), 180_000, `Native ${name} proof timed out; retained ${root}`);
      if (code !== 0) throw new Error(`Native ${name} proof exited ${code}; retained ${root}\n${stdout}${stderr}`);
      assertStdout?.(stdout);
    } finally {
      await stopFixture(child, name);
    }
  } finally {
    hostCount = await stopHostFixtures(root, join(root, "run"));
  }
  assertHostCount(hostCount, root);
  await rm(root, { recursive: true, force: true });
}
