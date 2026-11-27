import type { Database } from "bun:sqlite";
import { deferredRecoveryCandidate, physicalRouteKey, routingConversation, type DeferredRoutingPort, type Inbound, type Lane } from "../contracts";

const LEGACY_QUEUE = "intake:deferred-routing";
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS deferred_routing (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    conversation TEXT NOT NULL, physical_route TEXT NOT NULL, message_id TEXT,
    priority TEXT, stop_lane TEXT, choice_at INTEGER, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deferred_routing_conversation
    ON deferred_routing(conversation, sequence, id);
  CREATE INDEX IF NOT EXISTS deferred_routing_priority
    ON deferred_routing(conversation, sequence, priority) WHERE priority IS NOT NULL;
  CREATE INDEX IF NOT EXISTS deferred_routing_named_stop
    ON deferred_routing(stop_lane, sequence) WHERE stop_lane IS NOT NULL;
  CREATE INDEX IF NOT EXISTS deferred_routing_bare_stop
    ON deferred_routing(physical_route, sequence) WHERE priority = 'bare-stop';
  CREATE INDEX IF NOT EXISTS deferred_routing_message
    ON deferred_routing(physical_route, message_id, sequence, id);
  CREATE INDEX IF NOT EXISTS deferred_routing_choice
    ON deferred_routing(physical_route, choice_at) WHERE choice_at IS NOT NULL;
`;

// A missing queue ID is a new direct receipt. In that case the snapshot
// includes every row already queued, regardless of its conversation.
const EARLIER = `sequence <= COALESCE(
  (SELECT sequence - 1 FROM deferred_routing WHERE id = ?1),
  (SELECT max(sequence) FROM deferred_routing))`;

interface DataRow { readonly data: string }
interface IdRow { readonly id: string }

export interface DeferredChoiceRow {
  readonly id: string;
  readonly text: string;
  readonly messageId: string | null;
  readonly replyId: string | null;
  readonly authoredAt: number;
}

export class DeferredRoutingQueue implements DeferredRoutingPort {
  constructor(private readonly db: Database,
    private readonly reconcileInbound: (existing: Inbound, incoming: Inbound) => Inbound | null) {
    this.db.transaction(() => {
      this.db.run(SCHEMA);
      const legacy = this.db.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key = ?").get(LEGACY_QUEUE);
      if (!legacy) return;
      const queue: readonly Inbound[] = JSON.parse(legacy.value);
      if (!Array.isArray(queue)) throw new TypeError("Invalid legacy deferred routing queue");
      for (const input of queue) this.enqueue(input);
      this.db.query("DELETE FROM metadata WHERE key = ?").run(LEGACY_QUEUE);
    }).immediate();
  }

  enqueue(input: Inbound): void {
    const candidate = deferredRecoveryCandidate(input.text);
    const choiceAt = !input.pickerSelection && (typeof input.messageId === "string" || typeof input.interactionId === "string")
      && Number.isSafeInteger(input.receivedAt) ? input.receivedAt : null;
    this.db.query(`INSERT INTO deferred_routing
      (id, conversation, physical_route, message_id, priority, stop_lane, choice_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, routingConversation(input.route), physicalRouteKey(input.route), input.messageId,
      candidate?.kind ?? null, candidate?.kind === "lane-stop" ? candidate.laneId : null,
      choiceAt, JSON.stringify(input),
    );
  }

  reconcile(incoming: Inbound): boolean {
    const existing = this.input(incoming.id);
    if (!existing) return false;
    const refreshed = this.reconcileInbound(existing, incoming);
    if (refreshed) this.db.query("UPDATE deferred_routing SET data = ? WHERE id = ?").run(JSON.stringify(refreshed), incoming.id);
    return true;
  }

  input(id: string): Inbound | null {
    const row = this.db.query<DataRow, [string]>("SELECT data FROM deferred_routing WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) : null;
  }

  has(id: string): boolean {
    return this.db.query("SELECT 1 FROM deferred_routing WHERE id = ?").get(id) !== null;
  }

  head(conversation: string): string | null {
    return this.db.query<IdRow, [string]>(`
      SELECT id FROM deferred_routing WHERE conversation = ? ORDER BY sequence LIMIT 1
    `).get(conversation)?.id ?? null;
  }

  conversations(): readonly string[] {
    return this.db.query<{ conversation: string }, []>(`
      SELECT conversation FROM deferred_routing GROUP BY conversation ORDER BY min(sequence)
    `).all().map(row => row.conversation);
  }

  *priority(conversation: string, includeBare: boolean): Iterable<Inbound> {
    const rows = this.db.query<DataRow, [string, number]>(`
      SELECT data FROM deferred_routing INDEXED BY deferred_routing_priority WHERE conversation = ? AND priority IS NOT NULL
        AND (? OR priority <> 'bare-stop') ORDER BY sequence
    `).iterate(conversation, Number(includeBare));
    for (const row of rows) yield JSON.parse(row.data);
  }

  *earlierLaneStops(lane: Pick<Lane, "id" | "route">, beforeId: string): Iterable<Inbound> {
    // A bare stop binds only by its exact Discord thread route. Named stops
    // can come from any conversation but need not read other lanes' candidates.
    const rows = this.db.query<DataRow, [string, string, string]>(`
      SELECT data, sequence FROM deferred_routing INDEXED BY deferred_routing_named_stop WHERE stop_lane = ?2 AND ${EARLIER}
      UNION ALL
      SELECT data, sequence FROM deferred_routing INDEXED BY deferred_routing_bare_stop
      WHERE physical_route = ?3 AND priority = 'bare-stop' AND ${EARLIER}
      ORDER BY sequence
    `).iterate(beforeId, lane.id, physicalRouteKey(lane.route));
    for (const row of rows) yield JSON.parse(row.data);
  }

  hasEarlierMessage(input: Pick<Inbound, "id" | "route">, messageId: string): boolean {
    return this.db.query(`
      SELECT 1 FROM deferred_routing WHERE physical_route = ?2 AND message_id = ?3 AND ${EARLIER} LIMIT 1
    `).get(input.id, physicalRouteKey(input.route), messageId) !== null;
  }

  idsBefore(id: string): readonly string[] {
    return this.db.query<IdRow, [string]>(`
      SELECT id FROM deferred_routing WHERE ${EARLIER} ORDER BY sequence
    `).all(id).map(row => row.id);
  }

  remove(id: string): void {
    this.db.query("DELETE FROM deferred_routing WHERE id = ?").run(id);
  }

  choices(input: Pick<Inbound, "id" | "route" | "receivedAt">, deadline: number): Iterable<DeferredChoiceRow> {
    return this.db.query<DeferredChoiceRow, [string, number, number, string]>(`
      SELECT id, json_extract(data, '$.text') AS text, message_id AS messageId,
        json_extract(data, '$.reply.messageId') AS replyId, choice_at AS authoredAt
      FROM deferred_routing INDEXED BY deferred_routing_choice
      WHERE physical_route = ? AND choice_at BETWEEN ? AND ? AND id <> ?
    `).iterate(physicalRouteKey(input.route), input.receivedAt, deadline, input.id);
  }
}
