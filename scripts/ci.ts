#!/usr/bin/env bun
import { delimiter, dirname, join, resolve } from "node:path";
import { discoverInstalledOmp, inspectInstalledOmp } from "../src/installed-omp";
import { activeManagedUlw } from "../src/managed-ulw";

const root = resolve(import.meta.dir, "..");
const command = [discoverInstalledOmp()];
const omp = await inspectInstalledOmp(command);
const ulw = activeManagedUlw();
const manifest = await Bun.file(join(ulw, "package.json")).json() as { omp: { extensions: string[] } };
if (manifest.omp.extensions.length !== 1) throw new Error("Native composition tests require one managed ULW entrypoint");
const env = {
  ...process.env,
  CI: "true",
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  OMP_SUPERAGENT_NATIVE_TEST: "1",
  OMP_SUPERAGENT_SETUP_PTY_TEST: "1",
  OMP_TEST_COMMAND: JSON.stringify(command),
  OMP_TEST_ULW_EXTENSION: resolve(ulw, manifest.omp.extensions[0]!),
};
console.log(`CI: Bun ${Bun.version}; installed OMP ${omp.version} (${command[0]}); ULW ${ulw}`);
for (const args of [["run", "check"], ["test", "test"]]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
    cwd: root, env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
