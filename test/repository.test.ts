import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

test.each([false, true])("repository discovery ignores inherited Git selection (explicit worktree: %s)", async worktree => {
  const root = await mkdtemp(join(await realpath("/tmp"), "sa-git-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const nested = join(second, "nested");
  const outside = join(root, "outside");
  try {
    for (const path of [first, second, nested, outside]) await mkdir(path, { recursive: true });
    for (const path of [first, second]) {
      const git = Bun.spawn(["git", "init", "--quiet", path], { stdout: "ignore", stderr: "pipe" });
      const error = await new Response(git.stderr).text();
      if (await git.exited !== 0) throw new Error(error);
    }
    const child = Bun.spawn([process.execPath, "-e", `
      import { repositoryRoot } from ${JSON.stringify(resolve(import.meta.dir, "../src/repository.ts"))};
      console.log(JSON.stringify([await repositoryRoot(${JSON.stringify(nested)}), await repositoryRoot(${JSON.stringify(outside)})]));
    `], {
      env: { ...process.env, GIT_DIR: join(first, ".git"),
        ...(worktree ? { GIT_WORK_TREE: first, GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: first, GIT_CEILING_DIRECTORIES: second } : {}) },
      stdout: "pipe", stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(error);
    expect(JSON.parse(output)).toEqual([await realpath(second), null]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
