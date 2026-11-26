import { realpathSync } from "node:fs";

/** Discover this cwd's repository, never a repository selected by the launcher's Git environment. */
export async function repositoryRoot(cwd: string): Promise<string | null> {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("GIT_")));
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  const git = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { env, stdout: "pipe", stderr: "ignore" });
  const root = (await new Response(git.stdout).text()).trim();
  return await git.exited === 0 ? realpathSync(root) : null;
}
