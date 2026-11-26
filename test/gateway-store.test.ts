import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Inbound, Route } from "../src/contracts";
import type { GatewayEvent } from "../src/gateway-wire";
import { GatewayStore } from "./oracles/bun-gateway/gateway-store";

const route: Route = { platform: "telegram", accountId: "bot", authorityId: "owner",
  guildId: null, channelId: "chat", threadId: null, topicId: "original" };
function message(
  id: string, text: string,
  extra: Partial<Pick<Inbound, "route" | "routingText" | "telegramProtectedCommand">> = {},
): GatewayEvent {
  return { kind: "message", input: { id, text, route, messageId: id, receivedAt: 123, attachments: [], ...extra } };
}

test("quarantine prioritizes barriers then exact whitespace recovery controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-store-"));
  let store: GatewayStore | undefined;
  try {
    store = new GatewayStore(root);
    const heldMessage = message("held", "unresolved ordinary input");
    expect(store.admit(heldMessage)).toBe(true);
    const held = store.next();
    assert(held, "Original message was not queued");
    store.attempt(held.sequence);
    store.receipt(held.sequence, "unresolved");

    const ordinary = message("ordinary", "ordinary input");
    expect(store.admit(ordinary)).toBe(true);
    expect(store.admit({ kind: "reconnect" })).toBe(true);
    const malformed = [
      "/restart now", "/stop head now", "/stop lane", "/stophead", "/stop Head",
      "/Stop head", "/stop\u0085head", "\u180E/restart", "/stop\u200Bhead",
      "/stop \u200Bhead", "/stop\u0000 head", "/restart\u0000", "/restart\u0000now",
      "/st\uD800op head", "/restart\uDC00",
    ];
    for (const [index, text] of malformed.entries()) {
      expect(store.admit(message(`malformed-${index}`, text))).toBe(true);
    }
    const protectedMessages = [
      message("protected-restart", "/restart", { telegramProtectedCommand: true }),
      message("protected-stop", "/stop", { telegramProtectedCommand: true }),
      message("protected-stop-head", "/stop \t head", { telegramProtectedCommand: true }),
      message("legacy-masked", "/stop head", { routingText: "" }),
    ];
    for (const event of protectedMessages) expect(store.admit(event)).toBe(true);
    const whitespace = "\t\n\v\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004" +
      "\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";
    const controls = [
      message("stop-head", `${whitespace}/stop${whitespace}head${whitespace}`),
      message("restart", "\n\uFEFF /restart\u3000\t"),
      message("stop", "\u00A0 /stop\r "),
      message("verified-telegram", "/stop head", { telegramProtectedCommand: false, routingText: "" }),
      message("slack", "/stop head", { route: { ...route, platform: "slack" }, routingText: "" }),
    ];
    const barrier: GatewayEvent = { kind: "reconnect", barrier: "initial" };
    for (const event of [...controls, barrier]) expect(store.admit(event)).toBe(true);
    store.close();
    store = new GatewayStore(root);
    expect(store.next(held.sequence)).toEqual({ sequence: held.sequence, event: heldMessage });
    for (const original of [barrier, ...controls]) {
      const queued = store.next();
      assert(queued, "Expected original recovery event");
      expect(queued.event).toEqual(original);
      store.receipt(queued.sequence, "accepted");
    }
    expect(store.next()).toEqual({ sequence: held.sequence, event: heldMessage });
    expect(store.pending()).toBe(malformed.length + protectedMessages.length + 3);
    store.receipt(held.sequence, "rejected");
    expect(store.next()?.event).toEqual(ordinary);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("quarantine selects legacy controls without changing their persisted event bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-store-"));
  const path = join(root, "coordination.sqlite");
  let store: GatewayStore | undefined;
  try {
    const held: GatewayEvent = { kind: "answer", approvalId: "held", response: { confirmed: true }, route };
    const text = "/stop\u202Fhead";
    const control = message("legacy-control", text, { routingText: text });
    const controlData = ` \n${JSON.stringify(control).replaceAll("/stop", String.raw`\/st\u006fp`)}\n`;
    const legacy = new Database(path, { create: true, strict: true });
    try {
      legacy.run(`CREATE TABLE gateway_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL, received_at INTEGER NOT NULL, delivered_at INTEGER, delivery_error TEXT
      )`);
      const insert = legacy.query("INSERT INTO gateway_events VALUES(NULL,?,?,1,?,?)");
      legacy.transaction(() => {
        insert.run("answer:held", JSON.stringify(held), 2, "Head rejected admitted event");
        insert.run("message:delivered", JSON.stringify(message("delivered", "/restart")), 2, null);
        const ordinary = "ordinary text ".repeat(64);
        for (let n = 0; n < 256; n++) {
          const id = `ordinary-${n}`;
          insert.run(`message:${id}`, JSON.stringify(message(id, ordinary)), null, null);
        }
        insert.run("message:legacy-control", controlData, null, null);
      }).immediate();
    } finally {
      legacy.close();
    }
    store = new GatewayStore(root);
    const next = store.next();
    assert(next, "Legacy recovery control missing");
    expect(next.event).toEqual(control);
    store.receipt(next.sequence, "accepted");
    expect(store.next()).toEqual({ sequence: 1, event: held, reconciliation: true });
    const ledger = new Database(path, { readonly: true, strict: true });
    try {
      expect(ledger.query<{ data: string }, []>(
        "SELECT data FROM gateway_events WHERE identity='message:legacy-control'",
      ).get()?.data).toBe(controlData);
    } finally {
      ledger.close();
    }
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
