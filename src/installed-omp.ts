import { readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const minimumVersion: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  .dependencies["@oh-my-pi/pi-coding-agent"];
const minimum = minimumVersion.split(".").map(Number);
export const supportedOmp = `>=${minimumVersion} <${minimum[0]! + 1}.0.0`;

/** Resolve outside dependency shims, including PATH injected by bun run/install. */
export function discoverInstalledOmp(path = process.env.PATH ?? ""): string {
  for (const directory of path.split(delimiter)) {
    if (!directory || /(?:^|[/\\])node_modules(?:[/\\]|$)/.test(directory)) continue;
    const candidate = Bun.which("omp", { PATH: directory });
    if (!candidate) continue;
    const executable = realpathSync(candidate);
    if (executable.startsWith(join(root, "node_modules") + "/")) continue;
    return executable;
  }
  throw new Error(`An installed stock OMP ${supportedOmp} is required on PATH; setup does not download or build OMP`);
}

/** Preserve native CLI arguments while keeping a bare omp independent of Bun's PATH. */
export function resolveOmpCommand(command: string[], path = process.env.PATH ?? ""): string[] {
  if (command[0] === "omp") return [discoverInstalledOmp(path), ...command.slice(1)];
  if (command.some(arg => isAbsolute(arg) && resolve(arg).startsWith(join(root, "node_modules") + "/")))
    throw new Error("Configure a separately installed OMP executable, not this project's SDK dependency");
  return [...command];
}

/** Inspect CLI metadata only; never open an agent or provider session. */
export async function inspectInstalledOmp(
  command: string[] = ["omp"], credentials: string[] = [], environment: NodeJS.ProcessEnv = process.env,
) {
  const argv = resolveOmpCommand(command, environment.PATH ?? "");
  const env = { ...environment };
  for (const name of credentials) delete env[name];
  const probe = async (flag: string) => {
    // Require the CLI itself, not a runtime/script wrapper with an ambiguous
    // native argv boundary. Metadata inspection never loads launch extensions.
    const child = Bun.spawn([argv[0]!, flag], {
      env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000,
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`Installed OMP ${flag} failed (${code}); diagnostic output suppressed to protect credentials`);
    return stdout;
  };
  const version = (await probe("--version")).trim();
  const match = version.match(/^omp\/(\d+)\.(\d+)\.(\d+)$/);
  const actual = match?.slice(1).map(Number);
  if (!actual || actual[0] !== minimum[0] ||
      actual[1]! < minimum[1]! || actual[1] === minimum[1] && actual[2]! < minimum[2]!)
    throw new Error(`Install a supported stock OMP ${supportedOmp} and configure its executable directly, not a runtime/script wrapper; setup does not download or build OMP`);
  const help = await probe("--help");
  const flags = ["--mode", "--resume", "--extension", "--model"];
  if (!flags.every(flag => new RegExp(`${flag}(?=[\\s,=])`).test(help)) || !/(?<![\w-])rpc(?![\w-])/.test(help))
    throw new Error("Installed OMP must support public stdio RPC, session resume, extensions, and model selection");
  return {
    version: actual.join("."), supported: supportedOmp, testedVersion: minimumVersion,
    stdioRpc: true, sessions: true, extensions: true, modelSelection: true,
  };
}
