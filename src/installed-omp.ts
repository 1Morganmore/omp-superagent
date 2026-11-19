import { realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  throw new Error("An installed stock OMP is required on PATH, or configure its executable directly");
}

/** Resolve path-like executables before any change to the launch working directory. */
export function resolveOmpCommand(command: string[], path = process.env.PATH ?? "", cwd = process.cwd()): string[] {
  const [entry, ...args] = command;
  if (!entry) throw new Error("Configure an installed OMP executable");
  const executable = entry === "omp" ? discoverInstalledOmp(path) : entry.includes("/") ? resolve(cwd, entry) : entry;
  if ([executable, ...args].some(arg => isAbsolute(arg) && resolve(arg).startsWith(join(root, "node_modules") + "/")))
    throw new Error("Configure a separately installed OMP executable, not this project's SDK dependency");
  return [executable, ...args];
}

/** Inspect CLI metadata only; never open an agent or provider session. */
export async function inspectInstalledOmp(
  command: string[], credentials: string[] = [], environment: NodeJS.ProcessEnv = process.env,
) {
  const path = environment.PATH ?? "";
  const [entry] = resolveOmpCommand(command, path);
  const executable = entry && (isAbsolute(entry) ? entry : Bun.which(entry, { PATH: path }));
  if (!executable) throw new Error(`Cannot find the configured OMP executable ${entry ?? ""} on PATH`);
  const env = { ...environment };
  for (const name of credentials) delete env[name];
  const probe = async (...args: string[]) => {
    // Require the CLI itself, not a runtime/script wrapper with an ambiguous
    // native argv boundary. Metadata inspection never loads launch extensions.
    const child = Bun.spawn([executable, ...args], {
      // Unlike --version, root help loads the CLI's bundled native addon.
      // Its first extraction and load on macOS can take more than ten seconds.
      env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: args[0] === "--version" ? 10_000 : 30_000,
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`OMP executable ${executable}: ${args.join(" ")} failed (${code}); diagnostic output suppressed to protect credentials`);
    return stdout;
  };
  const version = (await probe("--version")).trim().match(/^omp\/(\S+)$/)?.[1];
  if (!version)
    throw new Error(`${executable} did not identify as OMP; configure its executable directly, not a runtime/script wrapper`);
  const help = await probe("--help");
  const flags = ["--mode", "--resume", "--extension", "--model"];
  if (!flags.every(flag => new RegExp(`${flag}(?=[\\s,=])`).test(help)) || !/(?<![\w-])rpc-ui(?![\w-])/.test(help))
    throw new Error(`OMP ${version} at ${executable} must support public stdio RPC (rpc-ui), session resume, extensions, and model selection`);
  // Match the selected executable's process interface, not the package SDK or
  // a failed/empty daemon observation. Both CLIs advertise these on ps only.
  const processes = await probe("ps", "--help");
  const broker = /--global(?=[\s,=])/.test(processes);
  const daemon = /--signal(?=[\s,=])/.test(processes);
  if (broker === daemon)
    throw new Error(`OMP ${version} at ${executable} has an unrecognized process ownership interface (ps --help)`);
  const processBackend = broker ? "broker" as const : "daemon" as const;
  return {
    executable, version, processBackend,
    stdioRpc: true, sessions: true, extensions: true, modelSelection: true,
  };
}
