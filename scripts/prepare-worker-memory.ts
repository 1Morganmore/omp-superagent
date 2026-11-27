#!/usr/bin/env bun
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The standalone OMP extension loader supplies these stock modules directly.
// Bundle only the unexposed Mnemopi helpers, from the installed locked SDK.
const root = resolve(import.meta.dir, "..");
const nativeConfig = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/mnemopi/config"));
const result = await Bun.build({
  entrypoints: [join(root, "src/omp/worker-memory-sdk.ts")],
  target: "bun",
  format: "esm",
  minify: true,
  external: ["@oh-my-pi/pi-utils", "@oh-my-pi/pi-utils/lru", "@oh-my-pi/pi-natives",
    "@oh-my-pi/pi-ai", "@oh-my-pi/pi-ai/error", "@oh-my-pi/pi-catalog/hosts"],
  plugins: [{
    name: "stock-expand-tilde",
    setup(build) {
      // v19.2.1 imports only expandTilde here; path-utils re-exports it
      // unchanged from pi-utils. Do not pull unrelated editing tools into OMP.
      build.onResolve({ filter: /^\.\.\/tools\/path-utils$/ }, ({ importer }) =>
        importer === nativeConfig ? { path: "@oh-my-pi/pi-utils", external: true } : undefined);
    },
  }],
});
const [module] = result.outputs;
if (!result.success || !module || result.outputs.length !== 1)
  throw new AggregateError(result.logs, "Could not prepare the stock worker memory helpers");

const directory = join(root, ".upstream");
await mkdir(directory, { recursive: true });
const output = join(directory, "worker-memory-sdk.mjs");
const staging = `${output}.${crypto.randomUUID()}`;
await writeFile(staging, new Uint8Array(await module.arrayBuffer()), { flag: "wx" });
try { await rename(staging, output); }
finally { await rm(staging, { force: true }); }
