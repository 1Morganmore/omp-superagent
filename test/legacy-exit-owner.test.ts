import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireHostOwner } from "../src/omp/host-owner-path";

test.each([
  {
    entry: "SDK helper",
    command: async () => [process.execPath, "--no-env-file", resolve(import.meta.dir, "../src/host-sdk-helper.ts"), "exit"],
    refusal: "Unsupported Host SDK operation\n",
  },
  {
    entry: "Rust owner",
    command: async () => [await requireHostOwner(), "--verify-exit"],
    refusal: "Usage: omp-host-owner <absolute owner.json>\n",
  },
])("$entry does not accept the retired exit operation", async ({ command, refusal }) => {
  const root = await mkdtemp(join(tmpdir(), "sa-exit-"));
  const dir = join(root, "owner");
  const manifest = join(dir, "owner.json");
  try {
    await mkdir(dir, { mode: 0o700 });
    await writeFile(manifest, JSON.stringify({
      options: { sessionFile: join(dir, "session.jsonl"), socketPath: join(dir, "host.sock") },
    }), { mode: 0o600 });
    const child = Bun.spawn([...await command(), manifest], {
      cwd: dir, env: { PATH: "", HOME: root, USERPROFILE: root },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, child.stdout.text(), child.stderr.text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 1, stdout: "", stderr: refusal });
    expect(await readdir(dir)).toEqual(["owner.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
