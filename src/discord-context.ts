import { isDeepStrictEqual } from "node:util";
import { Type } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";
import { physicalRoute, physicalRouteKey, type DiscordPurposeNote, type DiscordPurposeRequest, type Route, type StorePort } from "./contracts";
import { DeliveryError } from "./delivery";

const PURPOSES = "discord:purposes";
type Metadata = Pick<StorePort, "getMeta" | "setMeta">;
interface Purposes {
  readonly notes: Readonly<Record<string, DiscordPurposeNote>>;
  readonly receipts: Readonly<Record<string, { readonly request: DiscordPurposeRequest; readonly result: readonly DiscordPurposeNote[] }>>;
}
const routeSchema = Type.Object({
  platform: Type.Literal("discord"), accountId: Type.String({ minLength: 1 }),
  authorityId: Type.String({ minLength: 1 }), channelId: Type.String({ minLength: 1 }),
  guildId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  threadId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
}, { additionalProperties: false });
const purposeSchema = Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" });
const noteSchema = Type.Object({ route: routeSchema, purpose: purposeSchema }, { additionalProperties: false });
const requestFields = { sourceId: Type.String({ minLength: 1, maxLength: 1000 }), route: routeSchema };
const stateSchema = Type.Object({
  notes: Type.Record(Type.String(), noteSchema),
  receipts: Type.Record(Type.String(), Type.Object({
    request: Type.Union([
      Type.Object({ ...requestFields, action: Type.Literal("set"), purpose: purposeSchema }, { additionalProperties: false }),
      Type.Object({ ...requestFields, action: Type.Literal("clear") }, { additionalProperties: false }),
    ]),
    result: Type.Array(noteSchema),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Parse the local IPC/tool boundary without accepting extra route selectors. */
export function discordPurposeRequest(value: unknown): DiscordPurposeRequest {
  const reject = () => new DeliveryError("Invalid Discord purpose request", "rejected");
  if (!record(value)) throw reject();
  const data = value;
  if (typeof data.sourceId !== "string" || !data.sourceId.trim() || data.sourceId.length > 1000 ||
    !record(data.route)) throw reject();
  const route = data.route;
  if (route.platform !== "discord" || typeof route.accountId !== "string" || !route.accountId ||
    typeof route.authorityId !== "string" || !route.authorityId || typeof route.channelId !== "string" || !route.channelId ||
    !(route.guildId === null || typeof route.guildId === "string" && route.guildId.length > 0) ||
    !(route.threadId === null || typeof route.threadId === "string" && route.threadId.length > 0) ||
    route.guildId === null && route.threadId !== null ||
    Object.keys(route).some(key => !["platform", "accountId", "authorityId", "guildId", "channelId", "threadId"].includes(key)) ||
    Object.keys(data).some(key => !["sourceId", "route", "action", "purpose"].includes(key))) throw reject();
  const destination: Route = { platform: "discord", accountId: route.accountId, authorityId: route.authorityId,
    channelId: route.channelId, guildId: route.guildId, threadId: route.threadId };
  const common = { sourceId: data.sourceId, route: destination };
  switch (data.action) {
    case "list":
    case "clear":
      if (Object.hasOwn(data, "purpose")) throw reject();
      return { ...common, action: data.action };
    case "set":
      if (typeof data.purpose !== "string" || !data.purpose.trim() || data.purpose.length > 4000) throw reject();
      return { ...common, action: "set", purpose: data.purpose };
    default: throw reject();
  }
}

/** Only the original conversation or its exact parent; never another allowed channel/sibling. */
export function authorizeDiscordPurpose(source: Route, destination: Route): void {
  const parent = { ...physicalRoute(source), threadId: null };
  if (source.platform !== "discord" || destination.platform !== "discord" ||
    physicalRouteKey(destination) !== physicalRouteKey(source) && physicalRouteKey(destination) !== physicalRouteKey(parent)) {
    throw new DeliveryError("Discord purpose destination is unrelated to the original source", "rejected");
  }
}

function state(store: Metadata): Purposes {
  const saved = store.getMeta(PURPOSES);
  if (saved === null) return { notes: {}, receipts: {} };
  const reject = () => new DeliveryError("Discord purpose state is damaged; existing notes were preserved", "rejected");
  let parsed: unknown;
  try { parsed = JSON.parse(saved); }
  catch (error) { if (error instanceof SyntaxError) throw reject(); throw error; }
  if (!Value.Check(stateSchema, parsed)) throw reject();
  for (const [key, note] of Object.entries(parsed.notes))
    if (key !== physicalRouteKey(note.route) || note.route.guildId === null && note.route.threadId !== null) throw reject();
  for (const [key, receipt] of Object.entries(parsed.receipts))
    if (key !== JSON.stringify([receipt.request.sourceId, physicalRouteKey(receipt.request.route)])) throw reject();
  return parsed;
}

export function discordPurposeNotes(store: Metadata, route: Route): readonly DiscordPurposeNote[] {
  const notes = state(store).notes;
  const parent = { ...physicalRoute(route), threadId: null };
  const keys = [...new Set([physicalRouteKey(parent), physicalRouteKey(route)])];
  return keys.flatMap(key => notes[key] ? [notes[key]] : []);
}

/** One synchronous metadata write atomically preserves the note and its source-bound receipt. */
export function changeDiscordPurpose(store: Metadata, request: DiscordPurposeRequest): readonly DiscordPurposeNote[] {
  if (request.action === "list") return discordPurposeNotes(store, request.route);
  const previous = state(store);
  const receiptKey = JSON.stringify([request.sourceId, physicalRouteKey(request.route)]);
  const saved = previous.receipts[receiptKey];
  if (saved) {
    if (!isDeepStrictEqual(saved.request, request)) throw new DeliveryError("Discord purpose source identity conflict", "rejected");
    return saved.result;
  }
  const notes = { ...previous.notes };
  const key = physicalRouteKey(request.route);
  switch (request.action) {
    case "set": notes[key] = { route: physicalRoute(request.route), purpose: request.purpose }; break;
    case "clear": delete notes[key]; break;
  }
  const parent = { ...physicalRoute(request.route), threadId: null };
  const result = [...new Set([physicalRouteKey(parent), key])].flatMap(id => notes[id] ? [notes[id]] : []);
  store.setMeta(PURPOSES, JSON.stringify({ notes, receipts: { ...previous.receipts, [receiptKey]: { request, result } } }));
  return result;
}
