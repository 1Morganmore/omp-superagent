import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Inbound, OutputRecord, Route } from "../../src/contracts";
import { gatewayFixture, until, type Head } from "./native-rust-gateway";

export type NativeRustGateway = ReturnType<typeof gatewayFixture>;
type SendReceipt = { readonly remoteId: string; readonly output: OutputRecord };
const route: Route = { platform: "discord", accountId: "2", authorityId: "1", guildId: "3", channelId: "4", threadId: null };

export async function withNativeRustGateway(proof: (fixture: NativeRustGateway) => Promise<void>, profile: "debug" | "release" = "debug"): Promise<void> {
  const root = await mkdtemp(join(await realpath("/tmp"), "osrg-"));
  const fixture = gatewayFixture(root, profile);
  let succeeded = false;
  try {
    await mkdir(fixture.home, { mode: 0o700 });
    const preflight = await fixture.sdk("prepare");
    console.log(preflight.stdout.trim());
    assert(!existsSync(fixture.sessionFile), "Initial startup must materialize its own stock OMP session");
    await proof(fixture);
    succeeded = true;
  } catch (error) {
    throw new Error(`Native Rust Gateway proof failed; retained config, SQLite and private logs: ${root}`, { cause: error });
  } finally {
    await fixture.cleanup(succeeded);
    if (succeeded) await rm(root, { recursive: true, force: true });
  }
}

export function input(id: string, text: string, destination = route): Inbound {
  return { id, messageId: id, route: destination, text, receivedAt: Date.now(), attachments: [] };
}

export const headInput = (id: string) => input(id, `/head Native lifecycle request ${id}`);

export function ledger<T>(fixture: NativeRustGateway, inspect: (db: Database) => T): T {
  const db = new Database(join(fixture.root, "coordination.sqlite"), { readonly: true, strict: true });
  try { return inspect(db); }
  finally { db.close(); }
}

export function meta(db: Database, key: string): string | undefined {
  return db.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key=?").get(key)?.value;
}

export async function sendReceipts(fixture: NativeRustGateway): Promise<readonly SendReceipt[]> {
  return (await readFile(join(fixture.root, "adapter-output.jsonl"), "utf8")).trim().split("\n")
    .map((line): SendReceipt => JSON.parse(line));
}

export async function verifyDelivery(fixture: NativeRustGateway, source: Inbound | string, effectId?: string): Promise<string> {
  const id = typeof source === "string" ? source : source.id;
  const destination = typeof source === "string" ? route : source.route;
  const messageId = typeof source === "string" ? source : source.messageId;
  const output = await until(() => ledger(fixture, db => {
    const state = db.query<{ state: string }, [string]>("SELECT state FROM inputs WHERE id=?").get(id)?.state;
    assert(state !== "uncertain" && state !== "cancelled", `Native request ${id} ended ${state}`);
    const rows = db.query<{ id: string; state: string; remote_id: string | null }, [string, string | null, string | null]>(
      "SELECT id,state,remote_id FROM outputs WHERE source_id=? AND (? IS NULL OR id=?)").all(id, effectId ?? null, effectId ?? null);
    assert(rows.length <= 1, `Request ${id} delivered multiple replies for ${effectId ?? "its model turn"}`);
    const [row] = rows;
    if (state === "done" && row?.state === "sent") return row;
  }), `durable input completion and sent output for ${effectId ?? id}`);
  await until(() => ledger(fixture, db => {
    const event = db.query<{ delivery_error: string | null; delivered: number }, [string]>(
      "SELECT delivery_error,delivered_at IS NOT NULL AS delivered FROM gateway_events WHERE identity=?").get(`message:${id}`);
    if (event?.delivered === 1) {
      assert.equal(event.delivery_error, null);
      return event;
    }
  }), `accepted native Gateway ingress receipt for ${id}`);
  const seen = (await sendReceipts(fixture)).filter(receipt =>
    receipt.output.sourceId === id && (!effectId || receipt.output.id === effectId));
  assert.equal(seen.length, 1);
  const [receipt] = seen;
  assert(receipt);
  assert.deepEqual({ id: receipt.output.id, remoteId: receipt.remoteId,
    route: receipt.output.route, replyTo: receipt.output.replyTo },
  { id: output.id, remoteId: output.remote_id, route: destination, replyTo: { route: destination, messageId } });
  return receipt.output.text;
}

export async function verifyTranscript(fixture: NativeRustGateway, heads: readonly Head[], requests: readonly string[]): Promise<void> {
  assert.deepEqual(JSON.parse((await fixture.sdk("transcript")).stdout), {
    requests,
    shutdowns: heads.map(({ pid, sessionId }) => ({ pid, sessionId, networkAttempts: 0 })),
  });
}
