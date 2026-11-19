import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { nativeTestCommand } from "./fixtures/native-command";
import { dependencies } from "../package.json";

const testedVersion = dependencies["@oh-my-pi/pi-coding-agent"];
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function installation(identity: string, help = "--mode rpc, rpc-ui --resume PATH --extension FILE --model MODEL") {
  const directory = mkdtempSync(join(tmpdir(), "superagent-test-command-"));
  directories.push(directory);
  const executable = join(directory, "omp");
  writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes("--version")) console.log(${JSON.stringify(`omp/${testedVersion}`)});
else if (process.argv[2] === "ps" && process.argv[3] === "--help") console.log("--signal SIGNAL");
else if (process.argv.includes("--help")) console.log(${JSON.stringify(help)});
else console.log(JSON.stringify({
  runtime: ${JSON.stringify(identity)},
  profile: process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : null,
}));
`);
  chmodSync(executable, 0o700);
  return { directory, executable: realpathSync(executable) };
}

test.each(["discovered", "explicit", "bare override"] as const)(
  "native test command launches the %s standalone runtime despite Bun dependency shims", async selection => {
    const installed = installation("installed");
    const override = installation("isolated");
    const dependency = installation("project-sdk");
    const shim = join(dependency.directory, "node_modules", ".bin");
    mkdirSync(shim, { recursive: true });
    symlinkSync(dependency.executable, join(shim, "omp"));
    const environment: NodeJS.ProcessEnv = { PATH: [shim, installed.directory].join(delimiter) };
    switch (selection) {
      case "discovered": break;
      case "explicit":
        environment.OMP_TEST_COMMAND = JSON.stringify([override.executable, "--profile", "isolated"]);
        break;
      case "bare override":
        environment.OMP_TEST_COMMAND = JSON.stringify(["omp", "--profile", "isolated"]);
        break;
      default: throw new Error(`Unhandled runtime selection: ${selection satisfies never}`);
    }

    const command = await nativeTestCommand(environment);
    const child = Bun.spawn(command, { env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);

    expect({ code, stderr, result: JSON.parse(stdout) }).toEqual({
      code: 0, stderr: "",
      result: {
        runtime: selection === "explicit" ? "isolated" : "installed",
        profile: selection === "discovered" ? null : "isolated",
      },
    });
  },
);

test.each(["null", "[]", '[""]', '["omp",3]', '"omp"'])(
  "invalid explicit native argv %s cannot fall back to the installed runtime", async override => {
    const installed = installation("installed");
    await expect(nativeTestCommand({ PATH: installed.directory, OMP_TEST_COMMAND: override }))
      .rejects.toThrow("OMP_TEST_COMMAND must be a nonempty JSON array of argv strings");
  },
);

test.each(["", "not-json"])("malformed native argv %j cannot fall back to discovery", async override => {
  const installed = installation("installed");
  await expect(nativeTestCommand({ PATH: installed.directory, OMP_TEST_COMMAND: override })).rejects.toThrow(SyntaxError);
});

test("an explicit runtime without rpc-ui cannot fall back to an otherwise usable runtime", async () => {
  const installed = installation("installed");
  const unsupported = installation("plain-rpc", "--mode rpc --resume PATH --extension FILE --model MODEL");
  await expect(nativeTestCommand({
    PATH: installed.directory, OMP_TEST_COMMAND: JSON.stringify([unsupported.executable]),
  })).rejects.toThrow("public stdio RPC (rpc-ui)");
});

test("native tests require a standalone installation when PATH contains only a dependency shim", async () => {
  const dependency = installation("project-sdk");
  const shim = join(dependency.directory, "node_modules", ".bin");
  mkdirSync(shim, { recursive: true });
  symlinkSync(dependency.executable, join(shim, "omp"));
  await expect(nativeTestCommand({ PATH: shim })).rejects.toThrow("installed stock OMP");
});
