import assert from "node:assert/strict";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

type SetupPaths = {
  readonly nativeConfig: string;
  readonly nativeFallbackConfig: string;
  readonly nativeDb: string;
  readonly nativeProjectConfig: string;
  readonly nativeMemories: string;
};

let layout: Promise<SetupPaths> | undefined;

async function readLayout(root: string, env: Record<string, string>): Promise<SetupPaths> {
  const settingsModule = import.meta.resolve("@oh-my-pi/pi-coding-agent/config/settings");
  const dirsModule = Bun.resolveSync("@oh-my-pi/pi-utils/dirs", dirname(fileURLToPath(settingsModule)));
  const resolver = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { join } from "node:path";
    import { getAgentDir, getAgentDbPath, getProjectAgentDir, getMemoriesDir, MAIN_CONFIG_FILENAMES } from ${JSON.stringify(dirsModule)};
    const agentDir = getAgentDir();
    console.log(JSON.stringify({
      nativeConfig: join(agentDir, MAIN_CONFIG_FILENAMES[0]),
      nativeFallbackConfig: join(agentDir, MAIN_CONFIG_FILENAMES[1]),
      nativeDb: getAgentDbPath(agentDir),
      nativeProjectConfig: join(getProjectAgentDir(process.cwd()), MAIN_CONFIG_FILENAMES[0]),
      nativeMemories: getMemoriesDir(agentDir),
    }));
  `], { cwd: root, env: { ...env, BUN_OPTIONS: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(resolver.stdout).text(), new Response(resolver.stderr).text(), resolver.exited,
  ]);
  assert(code === 0 && !stderr, `Native setup path resolver exited ${code}: ${stderr}`);
  const resolved: SetupPaths = JSON.parse(stdout);
  const insideRoot = (target: string) => {
    const suffix = relative(root, target);
    assert(suffix && !isAbsolute(suffix) && suffix.split(sep)[0] !== "..", `Native setup path is outside fixture: ${target}`);
    return suffix;
  };
  return {
    nativeConfig: insideRoot(resolved.nativeConfig),
    nativeFallbackConfig: insideRoot(resolved.nativeFallbackConfig),
    nativeDb: insideRoot(resolved.nativeDb),
    nativeProjectConfig: insideRoot(resolved.nativeProjectConfig),
    nativeMemories: insideRoot(resolved.nativeMemories),
  };
}

export async function setupNativePaths(root: string, env: Record<string, string>): Promise<SetupPaths> {
  // Initial PTY roots all use the same explicit agent-dir layout. Share only
  // relative names from the SDK: no native settings, profile, or files are reused.
  const paths = await (layout ??= readLayout(root, env));
  return {
    nativeConfig: join(root, paths.nativeConfig),
    nativeFallbackConfig: join(root, paths.nativeFallbackConfig),
    nativeDb: join(root, paths.nativeDb),
    nativeProjectConfig: join(root, paths.nativeProjectConfig),
    nativeMemories: join(root, paths.nativeMemories),
  };
}
