import { expect } from "bun:test";
import { strict as assert } from "node:assert";
import { EventEmitter, once } from "node:events";
import { physicalRoute, type Approval, type DialogResponse, type Inbound, type Lane, type OutputRecord } from "../../src/contracts";
import type { Superagent } from "../../src/runtime";
import type { Store } from "../../src/store";
import { lookupWorker, workerConnect, workerRef } from "../../src/worker-wire";
import { RecordingMessenger } from "./model-native-runtime";

export class DecisionParityMessenger extends RecordingMessenger {
  readonly cards: Approval[] = [];
  readonly dismissals: Approval[] = [];
  private readonly events = new EventEmitter();

  override async send(output: OutputRecord): Promise<string> {
    const receipt = await super.send(output);
    this.events.emit(`output:${output.id}`);
    return receipt;
  }

  override async showApproval(approval: Approval): Promise<string> {
    this.cards.push(structuredClone(approval));
    this.events.emit(`card:${approval.target}`);
    return `native-card:${approval.id}`;
  }

  override async dismissApproval(approval: Approval): Promise<void> {
    this.dismissals.push(structuredClone(approval));
  }

  private async recorded<T>(event: string, find: () => T | undefined): Promise<T> {
    if (!find()) {
      try { await once(this.events, event, { signal: AbortSignal.timeout(30_000) }); }
      catch (cause) { throw new Error(`Missing worker parity observation: ${event}`, { cause }); }
    }
    const value = find();
    assert.ok(value, `Missing worker parity observation: ${event}`);
    return value;
  }

  output(id: string): Promise<OutputRecord> {
    return this.recorded(`output:${id}`, () => this.sent.find(output => output.id === id));
  }

  card(laneId: string): Promise<Approval> {
    return this.recorded(`card:${laneId}`, () => this.cards.find(card => card.target === laneId));
  }
}

/** Use the existing loopback sshd enrollment and offline stock OMP provider. */
export async function verifyWorkerDecisionParity({ runtime, store, messenger, lane, stateDir }: {
  readonly runtime: Superagent;
  readonly store: Store;
  readonly messenger: DecisionParityMessenger;
  readonly lane: Lane;
  readonly stateDir: string;
}): Promise<void> {
  const route = lane.route;
  const source: Inbound = {
    id: "104", messageId: "104", text: "/head Ask for my choice of verification checks.",
    receivedAt: Date.now(), route, attachments: [],
  };
  await messenger.deliver(source);
  await messenger.output(`${source.id}:answer`);
  const owned = store.lane(lane.id);
  assert.ok(owned?.remote && owned.sessionId, "The chat lane must already own a verified worker session");
  const { inputId } = await runtime.messageLane(lane.id, "Ask the owner. [native-decision-submit]", source.id);
  const reportId = `report:${inputId}`;
  const card = await messenger.card(lane.id);
  assert.ok(card.decision, "Expected the worker's original structured decision");
  const { id } = card.decision;
  expect(card).toMatchObject({
    route, target: lane.id, generation: owned.generation,
    decision: { sourceId: source.id, sessionId: owned.sessionId },
  });
  const reviewId = `lane-decision-review:${card.id}`;
  expect(store.input(reviewId)).toMatchObject({ route, state: "done", target: "main" });
  expect(store.input(inputId)).toMatchObject({ state: "submitted", target: lane.id });
  expect(store.input(reportId)).toBeNull();

  const answers: NonNullable<DialogResponse["answers"]> = [
    { id: `${id}:0`, selectedOptions: ["Local"] },
    { id: `${id}:1`, selectedOptions: ["Types", "Tests"] },
  ];
  assert.ok(messenger.handlers, "The head must own the messenger approval callback");
  await messenger.handlers.answer(card.id, { answers }, route);
  expect(runtime.inspectDecision(id)).toMatchObject({
    state: "answered", target: lane.id, sourceId: source.id, generation: owned.generation,
    sessionId: owned.sessionId, approvalId: card.id, requestId: card.requestId, response: { answers },
  });
  expect(messenger.cards.map(item => item.id)).toEqual([card.id]);
  expect(messenger.dismissals.map(item => ({ id: item.id, state: item.state }))).toEqual([{ id: card.id, state: "answered" }]);

  const delivered = await messenger.output(`${reportId}:answer`);
  expect(delivered).toMatchObject({ route, sourceId: reportId, replyTo: { route: physicalRoute(route), messageId: source.messageId } });
  expect(messenger.sent.filter(output => output.sourceId === reportId)).toEqual([delivered]);
  expect(store.input(reportId)?.text).toContain("Native decision tool finished");

  // The card ledger alone cannot show that the original native tool received the answer.
  // Read its actual stock journal through the enrolled worker's existing inspection surface.
  const host = await workerConnect(await lookupWorker(stateDir, owned.remote), workerRef(owned));
  try {
    expect(await host.client.getState()).toMatchObject({ sessionId: owned.sessionId, hostPid: owned.pid, pendingUiRequests: [] });
    const journal = await host.request({ type: "get_entries" });
    assert.ok(journal.success && journal.command === "get_entries", "The enrolled worker must expose its bound journal");
    const decisions = journal.data.entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolName === "decision_ask" ? [entry.message] : []);
    expect(decisions).toEqual([expect.objectContaining({
      isError: false,
      details: { id, status: "submitted", answers: [
        { ...answers[0], question: "Which release route?", options: ["Local", "Review"], multi: false },
        { ...answers[1], question: "Which checks?", options: ["Types", "Tests"], multi: true },
      ] },
    })]);
  } finally { await host.close(); }
}
