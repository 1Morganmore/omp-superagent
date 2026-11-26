import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../../src/config/config";
import { until, type Head } from "./native-rust-gateway";
import { ledger, meta, type NativeRustGateway } from "./native-rust-gateway-assertions";

export const headIdleMs = 4_000;
type Instance = Awaited<ReturnType<NativeRustGateway["start"]>>;
type ModelObservation = Awaited<ReturnType<NativeRustGateway["observeModel"]>>;

export async function configureIdleHead(fixture: NativeRustGateway): Promise<void> {
  const config = await loadConfig(fixture.config);
  await writeFile(fixture.config, JSON.stringify({ ...config, headIdleMs }));
}

export async function waitForDormantHead(
  fixture: NativeRustGateway, { head, gatewayPid }: Instance,
): Promise<string> {
  const receipt = await until(async () => {
    const { gateway, head: live } = await fixture.status();
    assert.equal(gateway.pid, gatewayPid, "Sleeping must not replace the Gateway");
    assert.equal(gateway.admissionReady, true, "Sleep must not close durable intake");
    assert.equal(live.rotation, undefined, "Hibernation must not be reported as rotation");
    assert.notEqual(live.hibernation?.stage, "refused", JSON.stringify(live));
    if (live.hibernation?.stage !== "sleeping") return;
    assert.equal(live.hibernation.sessionId, head.sessionId);
    assert.equal(live.pid, null);
    assert.equal(live.ready, false);
    assert.equal(live.connected, false);
    assert.equal(existsSync(live.socketPath), false);
    return live.hibernation;
  }, "verified dormant HEAD on the existing Gateway");
  const plan = ledger(fixture, db => {
    const value = meta(db, "gateway:head-rotation");
    assert(value, "Dormancy must have a durable transition receipt");
    return JSON.parse(value);
  });
  assert.deepEqual({ id: plan.id, mode: plan.mode, stage: plan.stage, sessionFile: plan.sessionFile },
    { id: receipt.id, mode: "hibernate", stage: "sleeping", sessionFile: head.sessionFile });
  await fixture.headExit(head);
  return receipt.id;
}

export function assertSameSession(replacement: Head, prior: Head): void {
  assert.notEqual(replacement.pid, prior.pid);
  assert.notEqual(replacement.ownerPid, prior.ownerPid);
  assert.equal(replacement.sessionId, prior.sessionId);
  assert.equal(replacement.sessionFile, prior.sessionFile);
}

export function assertRestoredSelection(actual: ModelObservation, expected: ModelObservation): void {
  assert.deepEqual(actual.model, expected.model);
  assert.deepEqual(actual.modelSettings, expected.modelSettings);
  // The Gateway fixture's non-reasoning models can expose no active effort
  // in stock RPC, or expose explicit "off"; both mean no reasoning.
  assert.equal(actual.configuredThinkingLevel ?? "off", expected.configuredThinkingLevel ?? "off");
  assert.equal(actual.thinkingLevel.value ?? "off", expected.thinkingLevel.value ?? "off");
}
