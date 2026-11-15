#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { activeManagedUlw } from "../src/managed-ulw";
import upstream from "../upstream/omp.json";

const root = resolve(import.meta.dir, "..");
const ulw = activeManagedUlw();
const manifest = await Bun.file(join(ulw, "package.json")).json() as { omp: { extensions: string[] } };
if (manifest.omp.extensions.length !== 1) throw new Error("Native composition tests require one managed ULW entrypoint");
const env = {
  ...process.env,
  CI: "true",
  OMP_SUPERAGENT_NATIVE_TEST: "1",
  OMP_SUPERAGENT_SETUP_PTY_TEST: "1",
  OMP_TEST_COMMAND: JSON.stringify([process.execPath, "--no-env-file", resolve(root, upstream.checkout, upstream.runtime.entry)]),
  OMP_TEST_NATIVES_DIR: resolve(root, upstream.checkout, "packages/natives/native"),
  OMP_TEST_ULW_EXTENSION: resolve(ulw, manifest.omp.extensions[0]!),
};
console.log(`CI: Bun ${Bun.version}; OMP ${upstream.revision}; ULW ${ulw}`);
for (const args of [["run", "check"], ["test", "test"]]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
    cwd: root, env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
