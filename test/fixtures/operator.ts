import { isAbsolute, resolve } from "node:path";
import { invokeOperator, type OperatorRun } from "../../src/operator/operator";

/** Resolve the example through Cargo, regardless of any inherited test handoff. */
async function buildOperatorExample(): Promise<string> {
  const build = await Bun.$`cargo build --locked --manifest-path gateway/Cargo.toml --example operator-loopback --message-format=json-render-diagnostics`
    .cwd(resolve(import.meta.dir, "../..")).quiet();
  for (const line of build.text().trim().split("\n")) {
    const artifact = JSON.parse(line);
    if (artifact.reason === "compiler-artifact" && artifact.target.name === "operator-loopback"
      && artifact.target.kind.includes("example") && typeof artifact.executable === "string"
      && isAbsolute(artifact.executable)) return artifact.executable;
  }
  throw new Error("Cargo did not report the operator-loopback example executable");
}

let executable: Promise<string> | undefined;
export async function operatorExample(): Promise<string> {
  // The test launcher passes the executable reported by its successful build to each worker.
  const prebuilt = process.env.OMP_TEST_OPERATOR_LOOPBACK_BIN;
  if (prebuilt !== undefined) {
    if (!isAbsolute(prebuilt)) throw new Error("OMP_TEST_OPERATOR_LOOPBACK_BIN must be an absolute path");
    return prebuilt;
  }
  return executable ??= buildOperatorExample();
}

export function loopbackOperator(fetch: (request: Request) => Response | Promise<Response>): OperatorRun {
  return async (operation, request, credentials, signal) => {
    let failure: Error | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        try { return await fetch(request); }
        catch (error) {
          failure = error instanceof Error ? error : new Error("Operator fixture assertion failed");
          return new Response(null, { status: 500 });
        }
      },
    });
    try {
      return await invokeOperator([await operatorExample(), String(server.port), operation],
        request, credentials, signal);
    } finally {
      await server.stop(true);
      if (failure) throw failure;
    }
  };
}

if (import.meta.main) console.log(await buildOperatorExample());
