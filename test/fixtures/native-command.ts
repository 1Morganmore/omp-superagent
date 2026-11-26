import { isAbsolute } from "node:path";
import { discoverInstalledOmp, inspectInstalledOmp, resolveOmpCommand } from "../../src/omp/installed-omp";

export function nativeTestArgv(environment: NodeJS.ProcessEnv = process.env): string[] {
  if (environment.OMP_TEST_COMMAND === undefined) {
    return [discoverInstalledOmp(environment.PATH ?? "")];
  }
  const parsed: unknown = JSON.parse(environment.OMP_TEST_COMMAND);
  if (!Array.isArray(parsed) || !parsed.length ||
    !parsed.every((arg: unknown): arg is string => typeof arg === "string" && arg.length > 0)) {
    throw new Error("OMP_TEST_COMMAND must be a nonempty JSON array of argv strings");
  }
  return resolveOmpCommand(parsed, environment.PATH ?? "");
}

/** Shared opt-in harness preflight; metadata inspection never opens a provider session. */
export async function nativeTestCommand(environment: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const command = nativeTestArgv(environment);
  const cache = environment.OMP_TEST_NATIVES_DIR;
  if (cache && !isAbsolute(cache)) throw new Error("OMP_TEST_NATIVES_DIR must be absolute");
  const omp = await inspectInstalledOmp(command, [], cache ? { ...environment, PI_NATIVES_DIR: cache } : environment);
  console.log(`Native tests: Bun ${Bun.version}; installed OMP ${omp.version} (${command[0]})`);
  return command;
}
