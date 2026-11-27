import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Each suite owns its own temporary directories and original environment values. */
export function testResources(prefix: string) {
  const directories: string[] = [];
  const environment = new Map<string, string | undefined>();

  return {
    directory(): string {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      directories.push(directory);
      return directory;
    },
    setEnvironment(name: string, value?: string): void {
      if (!environment.has(name)) environment.set(name, process.env[name]);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    },
    restore(): void {
      for (const [name, value] of environment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      environment.clear();
      for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    },
  };
}
