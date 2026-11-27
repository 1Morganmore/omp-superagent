import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { physicalRouteKey, type Approval, type Inbound, type Route } from "../src/contracts";
import { decisionId, decisionViews } from "../src/lane/decisions";
import { Store } from "../src/storage/store";

const route: Route = {
  platform: "discord", accountId: "bot", authorityId: "owner", guildId: "guild", channelId: "channel", threadId: "thread",
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function legacyDatabase(seed: (db: Database) => void): string {
  const directory = mkdtempSync(join(tmpdir(), "omp-superagent-scope-upgrade-"));
  directories.push(directory);
  const path = join(directory, "coordination.sqlite");
  using db = new Database(path);
  db.run(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE inputs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL,
      target TEXT, state TEXT NOT NULL DEFAULT 'pending', request_id TEXT, generation INTEGER,
      UNIQUE(target, generation, request_id)
    );
    CREATE TABLE outputs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL,
      route TEXT NOT NULL, physical_route TEXT, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      remote_id TEXT, error TEXT, reply_to TEXT, picker TEXT, result_attachment TEXT, edit_of TEXT, status INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE approvals (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, target TEXT NOT NULL,
      generation INTEGER NOT NULL, request_id TEXT NOT NULL, data TEXT NOT NULL,
      state TEXT NOT NULL, remote_id TEXT, UNIQUE(target, generation, request_id)
    );
    CREATE TABLE scope_reviews (
      id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL, lane_id TEXT NOT NULL,
      generation INTEGER NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL, operator_revision TEXT NOT NULL,
      lane_revision TEXT NOT NULL, state TEXT NOT NULL, correction_id TEXT NOT NULL UNIQUE, correction_requested INTEGER NOT NULL DEFAULT 0
    );
  `);
  seed(db);
  return path;
}

function addInput(db: Database, id: string, target: string | null, state: string, requestId: string | null = null) {
  const inbound: Inbound = { id, route, messageId: null, text: "Legacy receipt", receivedAt: 42, attachments: [] };
  db.run("INSERT INTO inputs(id,data,target,state,request_id,generation) VALUES (?,?,?,?,?,?)",
    [id, JSON.stringify(inbound), target, state, requestId, requestId ? 3 : null]);
}

test("upgrade never dispatches retired scope receipts or repeats their delivery", () => {
  const sourceId = "owner-1";
  const completedReview = "scope-review:completed-review";
  const queuedReview = "scope-review:queued-review";
  const queuedCorrection = `handoff:${completedReview}:lane`;
  const liveReview = "scope-review:admitted-review";
  const liveCorrection = "handoff:scope-review:granted-review:lane";
  const originalLaneRun = `handoff:${sourceId}:lane`;
  const interruptedReview = `scope-review:${originalLaneRun}`;
  const path = legacyDatabase(db => {
    addInput(db, sourceId, null, "done");
    addInput(db, originalLaneRun, "lane", "done", "native-handoff");
    addInput(db, completedReview, "main", "done", "review-done");
    addInput(db, interruptedReview, "main", "done", "review-interrupted-send");
    addInput(db, "legacy-descendant", "main", "done", "older-report");
    addInput(db, queuedReview, "main", "pending");
    addInput(db, queuedCorrection, "lane", "pending");
    addInput(db, liveReview, "main", "submitted", "review-live");
    addInput(db, liveCorrection, "lane", "submitted", "correction-live");
    addInput(db, "new-lane-input", "lane", "pending");
    const meta = db.query("INSERT INTO metadata VALUES (?,?)");
    meta.run("main:active-lane-recovery", liveReview);
    meta.run(`head-native-owner:${liveReview}`, '{"sessionId":"old-head"}');
    meta.run(`user-source:${sourceId}`, "true");
    meta.run(`activity-source:${completedReview}`, sourceId);
    meta.run(`report-approval-source:${completedReview}`, sourceId);
    meta.run("activity-source:legacy-descendant", completedReview);
    meta.run("report-approval-source:legacy-descendant", sourceId);
    db.run("INSERT INTO scope_reviews VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [liveReview, "handoff-1", sourceId, "lane", 3, "lane-session", "native-handoff", "0", "0", "review", `handoff:${liveReview}:lane`, 1]);
    const out = db.query("INSERT INTO outputs(id,source_id,route,physical_route,text,state,remote_id) VALUES (?,?,?,?,?,?,?)");
    const destination = JSON.stringify(route);
    const physical = physicalRouteKey(route);
    out.run(`${completedReview}:answer`, sourceId, destination, physical, "Stale answer", "pending", null);
    out.run(`${interruptedReview}:answer`, sourceId, destination, physical, "Unconfirmed answer", "sending", null);
    out.run(`${completedReview}:previous`, sourceId, destination, physical, "Delivered answer", "sent", "remote-message");
    out.run("ordinary-answer", sourceId, destination, physical, "Regular answer", "pending", null);
  });

  // Reopen twice: the second startup must not reinterpret uncertainty or queue a replay.
  for (const _attempt of [1, 2]) {
    const store = new Store(path);
    try {
      expect(store.inputs(undefined, "pending").map(input => input.id)).toEqual(["new-lane-input"]);
      expect(store.input(queuedReview)?.state).toBe("cancelled");
      expect(store.input(queuedCorrection)?.state).toBe("cancelled");
      expect(store.input(liveReview)).toMatchObject({ state: "uncertain", requestId: "review-live", generation: 3 });
      expect(store.input(liveCorrection)).toMatchObject({ state: "uncertain", requestId: "correction-live", generation: 3 });
      expect(store.hasHeadRecoveryInput()).toBe(false);
      expect(store.getMeta("main:active-lane-recovery")).toBe("");
      expect(store.ownerSource("legacy-descendant")).toBeNull();
      expect(store.reportApprovalSource(completedReview)).toBeNull();
      expect(store.reportApprovalSource("legacy-descendant")).toBeNull();
      expect(store.ownerSource(sourceId)?.id).toBe(sourceId);
      expect(store.settle(liveReview, "done", { id: "unexpected-answer", text: "Must not escape" })).toBe(false);
      expect(store.inputs("lane", "pending").map(input => input.id)).toEqual(["new-lane-input"]);
      expect(store.outputs().map(output => output.id)).toEqual(["ordinary-answer"]);
      expect(store.output(`${completedReview}:answer`)?.state).toBe("failed");
      expect(store.claimOutput(`${completedReview}:answer`)).toBe(false);
      expect(store.output(`${interruptedReview}:answer`)?.state).toBe("uncertain");
      expect(store.claimOutput(`${interruptedReview}:answer`)).toBe(false);
      expect(store.hasPendingLaneResult("lane")).toBe(true);
      expect(store.output(`${completedReview}:previous`)).toMatchObject({ state: "sent", remoteId: "remote-message" });
    } finally { store.close(); }
  }
});

function legacyScopeAnswer(kind: "review" | "correction") {
  const sourceId = "discord:owner-instruction";
  const handoff = `handoff:${sourceId}:lane`;
  const review = `scope-review:${handoff}`;
  const correction = `handoff:${review}:lane`;
  const id = `${kind === "review" ? review : correction}:answer`;
  const messageId = "1010001";
  const originalRoute = { ...route, threadId: null, topicId: "original-topic" };
  const replyTo = { route: { ...route, threadId: null }, messageId };
  const text = "Settled legacy result for the original instruction";
  const seed = (db: Database, state: "pending" | "sending" = "pending") => {
    addInput(db, sourceId, null, "done");
    addInput(db, handoff, "lane", "done", "native-handoff");
    addInput(db, review, "main", "done", "native-review");
    if (kind === "correction") addInput(db, correction, "lane", "done", "native-correction");
    db.run("UPDATE inputs SET data = json_set(data,'$.route',json(?))", [JSON.stringify(originalRoute)]);
    db.run("UPDATE inputs SET data = json_set(data, '$.messageId', ?) WHERE id = ?", [messageId, sourceId]);
    db.run("UPDATE inputs SET generation = 7 WHERE id = ?", [review]); // HEAD uses its own generation.
    const meta = db.query("INSERT INTO metadata VALUES (?,?)");
    meta.run(`user-source:${sourceId}`, "true");
    meta.run(`topic-owner:${sourceId}`, "lane");
    meta.run(`handoff-source:${handoff}`, sourceId);
    meta.run(`activity-source:${review}`, sourceId);
    if (kind === "correction") {
      meta.run(`handoff-source:${correction}`, review);
      meta.run(`report-approval-source:${review}`, sourceId);
    }
    db.run(`INSERT INTO scope_reviews
      (id,handoff_id,source_id,lane_id,generation,session_id,request_id,operator_revision,lane_revision,state,correction_id,correction_requested)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [review, handoff, sourceId, "lane", 3, "old-lane-session", "native-handoff", "0", "0", "closed", correction, 0]);
    db.run("INSERT INTO outputs(id,source_id,route,physical_route,text,state,reply_to) VALUES (?,?,?,?,?,?,?)",
      [id, sourceId, JSON.stringify(originalRoute), physicalRouteKey(originalRoute), text, state, JSON.stringify(replyTo)]);
  };
  return { id, sourceId, review, correction, text, route: originalRoute, replyTo, seed };
}

test.each(["review", "correction"] as const)("upgrade delivers the settled legacy %s result once on its exact original reply", kind => {
  const { id, sourceId, text, route: destination, replyTo, seed } = legacyScopeAnswer(kind);
  const path = legacyDatabase(db => {
    seed(db);
    addInput(db, "later-owner", "lane", "done", "later-native-run");
    db.run("UPDATE inputs SET generation = 8 WHERE id = 'later-owner'");
  });
  const store = new Store(path);
  try {
    expect(store.inputs()).toEqual([]);
    expect(store.outputs(physicalRouteKey(destination))).toEqual([
      { id, sourceId, route: destination, replyTo, text, state: "pending", remoteId: null, error: null },
    ]);
    expect(store.hasPendingLaneResult("lane")).toBe(true);
    expect(store.hasPendingLaneResult("other-lane")).toBe(false);
    expect(store.claimOutput(id, true)).toBe(true);
    expect(store.output(id)).toMatchObject({ id, sourceId, route: destination, replyTo, text, state: "sending" });
    expect(store.claimOutput(id, true)).toBe(false);
    store.finishOutput(id, "sent", "8010001");
    expect(store.hasPendingLaneResult("lane")).toBe(false);
  } finally { store.close(); }
  const reopened = new Store(path);
  try {
    expect(reopened.outputs()).toEqual([]);
    expect(reopened.output(id)).toMatchObject({ state: "sent", remoteId: "8010001", replyTo });
    expect(reopened.claimOutput(id)).toBe(false);
  } finally { reopened.close(); }
});

test.each(["unfinished", "open-review", "generation", "account", "topic", "reply", "source"] as const)(
  "upgrade never sends a synthetic correction output with unproven %s", fault => {
    const record = legacyScopeAnswer("correction");
    const path = legacyDatabase(db => {
      record.seed(db);
      switch (fault) {
        case "unfinished":
          db.run("UPDATE inputs SET state = 'submitted' WHERE id = ?", [record.correction]);
          break;
        case "open-review":
          db.run("UPDATE scope_reviews SET state = 'granted' WHERE id = ?", [record.review]);
          break;
        case "generation":
          db.run("UPDATE inputs SET generation = 4 WHERE id = ?", [record.correction]);
          break;
        case "account":
          db.run("UPDATE outputs SET route = json_set(route, '$.accountId', 'other-bot') WHERE id = ?", [record.id]);
          break;
        case "topic":
          db.run("UPDATE outputs SET route = json_set(route, '$.topicId', 'other-topic') WHERE id = ?", [record.id]);
          break;
        case "reply":
          db.run("UPDATE outputs SET reply_to = json_set(reply_to, '$.messageId', '1010002') WHERE id = ?", [record.id]);
          break;
        case "source":
          db.run("DELETE FROM metadata WHERE key = ?", [`user-source:${record.sourceId}`]);
          break;
      }
    });
    const store = new Store(path);
    try {
      expect(store.outputs()).toEqual([]);
      expect(store.output(record.id)?.state).toBe("failed");
      expect(store.claimOutput(record.id)).toBe(false);
    } finally { store.close(); }
  },
);

test.each(["rejected", "uncertain", "attempted", "different-reply", "multiple-attempts"] as const)(
  "startup releases a retired delivery hold only with one exact completed rejection (%s)", receipt => {
    const { id, sourceId, text, route: destination, replyTo, seed } = legacyScopeAnswer("correction");
    const path = legacyDatabase(db => {
      seed(db, "sending");
      db.run(`CREATE TABLE gateway_effects (
        id TEXT PRIMARY KEY, operation TEXT NOT NULL, arguments TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('attempted','complete')), result TEXT
      )`);
      const send = [{
        id, sourceId, route: destination, text, replyTo: receipt === "different-reply" ? { ...replyTo, messageId: "1010002" } : replyTo,
        state: "sending", remoteId: null, error: null,
      }];
      db.run("INSERT INTO gateway_effects VALUES (?, 'send', ?, ?, ?)", [
        "ddbbe540-e48c-45ec-9e70-30f7552e3446", JSON.stringify(send), receipt === "attempted" ? "attempted" : "complete",
        receipt === "attempted" ? null : JSON.stringify({
          ok: false, error: "Messenger did not confirm delivery", certainty: receipt === "uncertain" ? "uncertain" : "rejected",
        }),
      ]);
      if (receipt === "multiple-attempts") {
        db.run("INSERT INTO gateway_effects VALUES (?, 'send', ?, 'attempted', NULL)",
          ["34ad0bfd-fc79-4ed2-87fb-87a17c0c9e7c", JSON.stringify(send)]);
      }
    });
    const store = new Store(path);
    try {
      expect(store.output(id)?.state).toBe("uncertain");
      expect(store.hasPendingLaneResult("lane")).toBe(true);
      expect(store.hasUnresolvedHeadDelivery()).toBe(true);
      expect(() => store.finishOutput(id, "pending")).toThrow("never retried");
      store.recoverDeliveries();
      const rejected = receipt === "rejected";
      expect(store.output(id)).toMatchObject({ state: rejected ? "failed" : "uncertain", remoteId: null, replyTo });
      expect(store.hasPendingLaneResult("lane")).toBe(!rejected);
      expect(store.hasUnresolvedHeadDelivery()).toBe(!rejected);
      expect(store.outputs()).toEqual([]);
      expect(store.claimOutput(id)).toBe(false);
      expect(() => store.finishOutput(id, "pending")).toThrow("never retried");
    } finally { store.close(); }
  },
);

test("resolving retired work does not reroute its uncaptured dialog before a later native owner", () => {
  const head = { target: "main", generation: 3, sessionId: "old-head" };
  const retiredId = "scope-review:unfinished";
  const path = legacyDatabase(db => {
    addInput(db, retiredId, "main", "submitted", "old-native-prompt");
    const meta = db.query("INSERT INTO metadata VALUES (?,?)");
    meta.run("main:sessionId", head.sessionId);
    meta.run("main:generation", String(head.generation));
  });
  const store = new Store(path);
  try {
    expect(store.settle(retiredId, "cancelled")).toBe(true);
    expect(store.isNativeApprovalHeld(head, "uncaptured-dialog")).toBe(true);
    expect(store.isNativeApprovalHeld({ ...head, sessionId: "replacement-head" }, "unowned-dialog")).toBe(false);

    const receive = (id: string) => store.receive(
      { id, route, messageId: `message-${id}`, text: id, receivedAt: 43, attachments: [] },
      "main", { [`user-source:${id}`]: "true" },
    );
    receive("stop-control");
    expect(store.submit("stop-control", "native-stop-control", head.generation)).toBe(true);
    expect(store.isNativeApprovalHeld(head, "uncaptured-dialog")).toBe(true);

    receive("new-owner-message");
    const requestId = "new-native-prompt";
    store.setMeta("head-native-owner:new-owner-message", JSON.stringify({
      generation: head.generation, sessionId: head.sessionId, requestId, sessionFile: "/sessions/head.jsonl", cursor: null,
    }));
    expect(store.submit("new-owner-message", requestId, head.generation)).toBe(true);
    const active = { ...head, input: { id: "new-owner-message", sessionFile: "/sessions/head.jsonl" } };
    expect(store.isNativeApprovalHeld(active, "new-owner-dialog")).toBe(false);
    expect(store.isNativeApprovalHeld(head, "no-live-owner")).toBe(true);
    expect(store.isNativeApprovalHeld({ ...active, input: { ...active.input, sessionFile: "/sessions/elsewhere.jsonl" } },
      "wrong-journal")).toBe(true);
    expect(store.settle(active.input.id, "done")).toBe(true);
    expect(store.isNativeApprovalHeld(active, "no-longer-owned")).toBe(true);
  } finally { store.close(); }
});

test("upgrading v0.1.13 retires unmarked HEAD cards only in an ambiguous original route and generation", () => {
  const approval: Approval = {
    id: "unmarked", target: "main", generation: 3, requestId: "old-native-question",
    route, state: "pending", remoteId: "original-card", request: { method: "confirm", title: "Continue?" },
  };
  const sessionId = "legacy-head";
  const doneReviewRoute = { ...route, threadId: "completed-review-thread" };
  const laterSourceId = "later-owner";
  const laterDecisionId = decisionId(sessionId, "later-owner-call");
  const ordinary = [{ ...approval, id: "another-topic", requestId: "ordinary-topic", route: { ...route, topicId: "sibling" } },
    { ...approval, id: "another-account", requestId: "ordinary-account", route: { ...route, accountId: "other-bot" } },
    { ...approval, id: "another-generation", generation: 4, requestId: "ordinary-generation" },
    { ...approval, id: "completed-review-route", requestId: "normal-after-completed-review", route: doneReviewRoute },
    { ...approval, id: "later-owned", requestId: "later-owned-decision",
      request: { method: "ask", questions: [{ id: `${laterDecisionId}:0`, question: "Choose", options: [{ label: "One" }] }] },
      decision: { id: laterDecisionId, sourceId: laterSourceId, sessionId } }];
  const path = legacyDatabase(db => {
    // The earlier migration already closed the admission, but lacked the
    // unmarked-card recovery step. The native UI itself was never settled.
    db.run("INSERT INTO metadata VALUES (?,?)", ["migration:retire-scope-review", "true"]);
    addInput(db, "scope-review:legacy", "main", "cancelled", "legacy-head-request");
    addInput(db, "scope-review:complete", "main", "done", "legacy-head-complete");
    db.run("UPDATE inputs SET data = json_set(data, '$.route', json(?)) WHERE id = 'scope-review:complete'", [JSON.stringify(doneReviewRoute)]);
    addInput(db, laterSourceId, "main", "submitted", "later-native-prompt");
    const meta = db.query("INSERT INTO metadata VALUES (?,?)");
    meta.run(`user-source:${laterSourceId}`, "true");
    meta.run(`head-native-owner:${laterSourceId}`, JSON.stringify({
      sessionId, generation: 3, requestId: "later-native-prompt", sessionFile: "/sessions/head.jsonl", cursor: "tail",
    }));
    meta.run("decisions:v1", JSON.stringify({ [laterDecisionId]: { approvalId: "later-owned", createdAt: 43 } }));
    const insert = db.query("INSERT INTO approvals(id,target,generation,request_id,data,state,remote_id) VALUES (?,?,?,?,?,?,?)");
    for (const card of [approval, ...ordinary])
      insert.run(card.id, card.target, card.generation, card.requestId, JSON.stringify(card), card.state, card.remoteId);
  });
  const store = new Store(path);
  try {
    expect(store.approvals()).toEqual(ordinary);
    expect(store.isNativeApprovalHeld({ target: "main", generation: 3, sessionId }, approval.id)).toBe(true);
    expect(store.claimRetiredApprovalDismissal(approval.id)).toEqual({ ...approval, state: "cancelled" });
    expect(store.claimRetiredApprovalDismissal(approval.id)).toBeNull();
  } finally { store.close(); }
});

test.each(["receipt", "prior-dismissal", "attempted-dismissal", "conflicting-receipt"] as const)(
  "retired dismissal respects original Gateway evidence: %s", mode => {
    const approval: Approval = {
      id: "retired", target: "main", generation: 3, requestId: "legacy-ui", route,
      state: "pending", remoteId: null, request: { method: "confirm", title: "Continue?" },
    };
    const receipt = { ...approval, remoteId: "original-card" };
    const path = legacyDatabase(db => {
      addInput(db, "scope-review:legacy", "main", "submitted", "legacy-head-request");
      db.run("INSERT INTO approvals(id,target,generation,request_id,data,state,remote_id) VALUES (?,?,?,?,?,?,?)",
        [approval.id, approval.target, approval.generation, approval.requestId, JSON.stringify(approval), approval.state, approval.remoteId]);
      db.run("CREATE TABLE gateway_effects (id TEXT PRIMARY KEY, operation TEXT, arguments TEXT, state TEXT, result TEXT)");
      const effect = db.query("INSERT INTO gateway_effects VALUES (?,?,?,?,?)");
      effect.run("show", "showApproval", JSON.stringify([approval]), "complete", '{"ok":true,"value":"original-card"}');
      effect.run("foreign", "showApproval", JSON.stringify([{ ...approval, route: { ...route, topicId: "wrong" } }]),
        "complete", '{"ok":true,"value":"foreign-card"}');
      if (mode === "prior-dismissal" || mode === "attempted-dismissal") effect.run("dismiss", "dismissApproval",
        JSON.stringify([receipt]), mode === "prior-dismissal" ? "complete" : "attempted",
        mode === "prior-dismissal" ? '{"ok":true}' : null);
      if (mode === "conflicting-receipt") effect.run("other", "showApproval", JSON.stringify([approval]),
        "complete", '{"ok":true,"value":"other-card"}');
    });
    const store = new Store(path);
    try {
      expect(store.claimRetiredApprovalDismissal(approval.id)).toEqual(mode === "receipt"
        ? { ...receipt, state: "cancelled" } : null);
      expect(store.retiredApprovalDismissals()).toEqual(mode === "prior-dismissal" ? [] : [approval.id]);
    } finally { store.close(); }
    if (mode === "receipt") {
      using db = new Database(path);
      db.run("INSERT INTO gateway_effects VALUES (?,?,?,?,?)",
        ["dismiss-after-lost-ack", "dismissApproval", JSON.stringify([receipt]), "complete", '{"ok":true}']);
    }
    const reopened = new Store(path);
    try {
      expect(reopened.claimRetiredApprovalDismissal(approval.id)).toBeNull();
      expect(reopened.retiredApprovalDismissals()).toEqual(mode === "prior-dismissal" || mode === "receipt" ? [] : [approval.id]);
    } finally { reopened.close(); }
  },
);

test("upgrade leaves exact approval tombstones without retiring ordinary topic approvals", () => {
  const owner = { target: "lane", generation: 3, sessionId: "lane-session" };
  const head = { target: "main", generation: 3, sessionId: "head-session" };
  const correction = "handoff:scope-review:old:lane";
  const questionId = decisionId(owner.sessionId, "legacy-tool-call");
  const retired: Approval = {
    id: "retired-approval", target: owner.target, generation: owner.generation, requestId: "old-question",
    route, state: "pending", remoteId: "original-card",
    request: { method: "ask", questions: [{ id: `${questionId}:0`, question: "Proceed?", options: [{ label: "Stop" }] }] },
    decision: { id: questionId, sourceId: "owner-1", sessionId: owner.sessionId },
  };
  const retiredHead: Approval = {
    id: "retired-head-approval", target: head.target, generation: head.generation, requestId: "old-head-question",
    route, state: "pending", remoteId: "original-head-card", request: { method: "confirm", title: "Continue?", message: "Review scope" },
  };
  const ordinary: Approval = {
    id: "ordinary-approval", target: owner.target, generation: owner.generation, requestId: "ordinary-question",
    route, state: "pending", remoteId: null, request: { method: "select", title: "Allow edit?", options: ["Approve", "Deny"] },
  };
  const path = legacyDatabase(db => {
    addInput(db, correction, owner.target, "submitted", "old-native-prompt");
    addInput(db, "owner-1", null, "done");
    const insert = db.query("INSERT INTO approvals(id,target,generation,request_id,data,state,remote_id) VALUES (?,?,?,?,?,?,?)");
    for (const card of [retired, retiredHead, ordinary])
      insert.run(card.id, card.target, card.generation, card.requestId, JSON.stringify(card), card.state, card.remoteId);
    const meta = db.query("INSERT INTO metadata VALUES (?,?)");
    meta.run(`scope-correction-approval-input:${retired.id}`, correction);
    meta.run(`scope-head-approval-input:${retiredHead.id}`, "scope-review:old");
    meta.run(`scope-review-approval-input:${ordinary.id}`, "handoff:ordinary-message:lane");
    meta.run(`scope-cancel:${head.sessionId}:unacknowledged-cancel`, "scope-review:old");
    meta.run("decisions:v1", JSON.stringify({ [questionId]: { approvalId: retired.id, createdAt: 42 } }));
  });

  const store = new Store(path);
  try {
    expect(store.approvals().map(card => card.id)).toEqual([ordinary.id]);
    expect(store.approval(retired.id)).toMatchObject({ ...retired, state: "cancelled" });
    expect(store.approval(retiredHead.id)).toMatchObject({ ...retiredHead, state: "cancelled" });
    expect(decisionViews(store)).toMatchObject([{ id: questionId, state: "withdrawn" }]);
    expect(store.resolveApproval(retired.id, owner.generation, "answered", { response: { cancelled: true } })).toBe(false);
    expect(store.isNativeApprovalHeld(owner, retired.id)).toBe(true);
    expect(store.isNativeApprovalHeld(head, retiredHead.id)).toBe(true);
    expect(store.isNativeApprovalHeld(head, "unacknowledged-cancel")).toBe(true);
    expect(store.isNativeApprovalHeld(owner, "unrecorded-native-card")).toBe(true);
    expect(store.isNativeApprovalHeld({ ...owner, generation: 4 }, "unrecorded-native-card")).toBe(false);
    expect(store.isNativeApprovalHeld(owner, ordinary.id)).toBe(false);
    expect(store.resolveApproval(ordinary.id, owner.generation, "answered", { response: { value: "Deny" } })).toBe(true);
  } finally { store.close(); }
});
