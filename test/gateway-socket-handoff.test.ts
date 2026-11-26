import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Config } from "../src/config/config";
import { createGatewayMessenger } from "../src/gateway/gateway-client";
import { gatewayCall, gatewayPaths, gatewayRequest, trustedGatewaySocket } from "../src/gateway/gateway-protocol";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await mkdtemp(join(await realpath("/tmp"), "ogw-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const run = join(root, "run");
  await mkdir(run, { mode: 0o700 });
  const config: Config = { path: join(root, "config.json"), stateDir: root, headCwd: root,
    command: ["unused"], maxHosts: 2, maxSubagents: 4, idleMs: 1000 };
  const socket = gatewayPaths(config).socketPath;
  const token = crypto.randomUUID();
  return {
    socket, original: join(run, "old.sock"), replacement: join(run, "next.sock"), token,
    client() {
      const saved = process.env.OMP_SUPERAGENT_GATEWAY_TOKEN;
      process.env.OMP_SUPERAGENT_GATEWAY_TOKEN = token;
      try {
        const client = createGatewayMessenger(config, AbortSignal.timeout(3000));
        cleanup.push(() => client.stop());
        return client;
      } finally {
        if (saved === undefined) delete process.env.OMP_SUPERAGENT_GATEWAY_TOKEN;
        else process.env.OMP_SUPERAGENT_GATEWAY_TOKEN = saved;
      }
    },
  };
}

async function listen(socket: string, serve: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    request.resume();
    void Promise.resolve(serve(request, response)).catch(error => { response.destroy(error); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await chmod(socket, 0o600);
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const attached = (admissionReady: boolean) => ({ ok: true, value: { admissionReady } });
const rejected = (error: string) => ({ ok: false, certainty: "rejected", error });
const handlers = { message: async () => {}, answer: async () => {} };

test.each(["/attach", "/events", "before /ready"])("first Gateway handshake reattaches after socket replacement at %s", async replaceAt => {
  const f = await fixture();
  const ready = Promise.withResolvers<void>();
  const enableIntake = Promise.withResolvers<void>();
  const seen: string[] = [];
  let authorizedClient: string | string[] | undefined;
  let reserved = 0;
  await listen(f.replacement, (request, response) => {
    if (request.url === undefined) throw new Error("Missing Gateway route");
    seen.push(request.url);
    if (request.headers.authorization !== `Bearer ${f.token}`) {
      json(response, rejected("Gateway head authorization required"), 400);
    } else if (request.url === "/attach") {
      authorizedClient = request.headers["x-gateway-client"];
      json(response, attached(true));
    } else if (request.headers["x-gateway-client"] !== authorizedClient || !authorizedClient) {
      json(response, rejected("Gateway client is detached"), 400);
    } else if (request.url === "/events") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.flushHeaders();
    } else {
      json(response, { ok: true });
      if (request.url === "/ready") ready.resolve();
    }
  });
  await listen(f.original, async (request, response) => {
    if (request.url === replaceAt) await rename(f.replacement, f.socket);
    if (request.url === "/attach") json(response, attached(false));
    else if (request.url === "/events" && replaceAt === "before /ready") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.flushHeaders();
    } else json(response, rejected("Gateway client is detached"), 400);
  });
  await rename(f.original, f.socket);
  const client = f.client();

  await client.start({ ...handlers, ready: enableIntake.promise, reserveStartupHistory: () => { reserved++; } });
  if (replaceAt === "before /ready") await rename(f.replacement, f.socket);
  enableIntake.resolve();
  await ready.promise;

  expect(seen).toEqual(["/attach", "/events", "/ready"]);
  expect(reserved).toBe(replaceAt === "before /ready" ? 1 : 0);
});

test("opening events with the attachment's socket identity never contacts a replacement already at the path", async () => {
  const f = await fixture();
  await listen(f.original, (_request, response) => json(response, attached(false)));
  const replacementRequests: (string | undefined)[] = [];
  await listen(f.replacement, (request, response) => {
    replacementRequests.push(request.url);
    json(response, rejected("Gateway client is detached"), 400);
  });
  await rename(f.original, f.socket);
  const options = { token: f.token, clientId: crypto.randomUUID(), expectedSocket: await trustedGatewaySocket(f.socket) };
  await gatewayCall(f.socket, "/attach", { pid: process.pid }, options);
  await rename(f.replacement, f.socket);

  await expect(gatewayRequest(f.socket, "/events", undefined, options)).rejects.toMatchObject({ certainty: "rejected" });
  expect(replacementRequests).toEqual([]);
});

test.each([
  ["attach authorization", rejected("Gateway head authorization rejected"), null, "Gateway head authorization rejected"],
  ["ordered-history compatibility", { ok: true }, null, "Gateway does not support ordered startup history"],
  ["event authorization", attached(false), rejected("Gateway client is detached"), "Gateway client is detached"],
] as const)("first handshake does not retry same-socket %s failure", async (_name, attach, eventFailure, reason) => {
  const f = await fixture();
  let attempts = 0;
  await listen(f.socket, (request, response) => {
    if (request.url === "/attach") {
      attempts++;
      json(response, attach);
    } else if (request.url === "/events") {
      json(response, eventFailure, 400);
    } else json(response, { ok: true });
  });
  const client = f.client();

  await expect(client.start({ ...handlers, reserveStartupHistory: () => {} })).rejects.toThrow(reason);
  expect(attempts).toBe(1);
});

test("first handshake will not send credentials to a socket with group permissions", async () => {
  const f = await fixture();
  const requests: (string | undefined)[] = [];
  await listen(f.socket, (request, response) => {
    requests.push(request.url);
    json(response, attached(false));
  });
  await chmod(f.socket, 0o660);
  const client = f.client();

  await expect(client.start(handlers)).rejects.toMatchObject({ message: "Gateway endpoint is not a private owned Unix socket", certainty: "rejected" });
  expect(requests).toEqual([]);
});
