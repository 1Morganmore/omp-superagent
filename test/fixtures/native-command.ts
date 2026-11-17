import { discoverInstalledOmp, inspectInstalledOmp, resolveOmpCommand } from "../../src/installed-omp";

/** Shared opt-in harness selection; metadata inspection never opens a provider session. */
export async function nativeTestCommand(environment: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  let command: string[];
  if (environment.OMP_TEST_COMMAND === undefined) {
    command = [discoverInstalledOmp(environment.PATH ?? "")];
  } else {
    const parsed: unknown = JSON.parse(environment.OMP_TEST_COMMAND);
    if (!Array.isArray(parsed) || !parsed.length ||
      !parsed.every((arg: unknown): arg is string => typeof arg === "string" && arg.length > 0)) {
      throw new Error("OMP_TEST_COMMAND must be a nonempty JSON array of argv strings");
    }
    command = resolveOmpCommand(parsed, environment.PATH ?? "");
  }
  const omp = await inspectInstalledOmp(command, [], environment);
  console.log(`Native tests: Bun ${Bun.version}; installed OMP ${omp.version} (${command[0]})`);
  return command;
}
