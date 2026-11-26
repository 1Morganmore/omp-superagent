import { on } from "node:events";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { parseConfig } from "./config";

/** No controller, store or messenger is opened on unapproved bytes. The
 * directory watch survives atomic replacement and is closed on Host stop. */
export async function loadWakeConfig(path: string, expectedHash: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const watcher = watch(dirname(path), { persistent: false });
  const changes = on(watcher, "change", { signal });
  try {
    for (;;) {
      signal.throwIfAborted();
      let bytes: ArrayBuffer | undefined;
      try { bytes = await Bun.file(path).arrayBuffer(); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (bytes && Bun.CryptoHasher.hash("sha256", bytes, "hex") === expectedHash) {
        return parseConfig(await new Blob([bytes]).json(), path);
      }
      // The config may live beside the live Gateway database. Its journal
      // writes are not a reason to reread the configuration.
      let filename: unknown;
      do {
        const event = await changes.next();
        if (event.done) throw new Error("Configuration watch closed before HEAD wake");
        [, filename] = event.value;
      } while (filename != null && filename !== basename(path));
    }
  } finally {
    watcher.close();
    await changes.return?.();
  }
}
