import type { Api, Model } from "@oh-my-pi/pi-ai";
import { resolveRoutedModelSelector } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { LaneModel } from "../contracts";
import { LANE_MODEL_PROMOTION_RECEIPT } from "../omp/host-protocol";
import { isLaneModel, laneModelArgument, sameLaneModel } from "../lane/lane-models";
import { record } from "./native-frames";

type JournaledModelChange = {
  readonly id: string;
  readonly model: string;
  readonly role?: string;
  readonly resolvedModelIsFallback?: boolean;
};

/** Prefer exact catalog IDs over optional native selector suffixes, never a prefix match. */
function recordedModel(selector: string, catalog: unknown[]): LaneModel | undefined {
  const models = catalog.filter(isLaneModel);
  const literal = models.find(model => laneModelArgument(model) === selector);
  if (literal) return literal;
  return resolveRoutedModelSelector({
    find: (provider, id) => models.find(model => model.provider === provider && model.id === id) as Model<Api> | undefined,
  }, selector)?.model;
}

/** Read model evidence on the exact RPC leaf, newest first. An invalid path is not evidence. */
function activeModelJournal(entries: unknown, leafId: string, after?: string):
  { readonly changes: JournaledModelChange[]; readonly branch: Record<string, unknown>[] } | null {
  if (!Array.isArray(entries)) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of entries) {
    const entry = record(value);
    if (typeof entry.id !== "string" || !entry.id || byId.has(entry.id)) return null;
    byId.set(entry.id, entry);
  }
  const changes: JournaledModelChange[] = [];
  const branch: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let crossed = after === undefined;
  let cursor: string | null = leafId;
  while (cursor !== null) {
    const entry = byId.get(cursor);
    if (!entry || seen.has(cursor) || (entry.parentId !== null && (typeof entry.parentId !== "string" || !entry.parentId))) return null;
    seen.add(cursor);
    branch.push(entry);
    if (cursor === after) {
      if (!changes.length) return null; // The newest model entry must be strictly after the boundary.
      crossed = true;
    }
    if (entry.type === "model_change") {
      const { model, role, resolvedModelIsFallback } = entry;
      if (typeof model !== "string" || !model || (role !== undefined && typeof role !== "string")
        || (resolvedModelIsFallback !== undefined && typeof resolvedModelIsFallback !== "boolean")) return null;
      changes.push({ id: cursor, model, role, resolvedModelIsFallback });
    }
    cursor = entry.parentId;
  }
  return crossed ? { changes, branch } : null;
}

/** Read the configured default; the caller still fences against a moving native leaf. */
export function nativeDefaultModelEvidence(result: Record<string, unknown>, catalog: unknown[], laneId: string):
  { readonly leaf: string | null; readonly selected?: LaneModel } {
  const leaf = result.leafId;
  if (leaf === null && Array.isArray(result.entries) && result.entries.length === 0) return { leaf };
  const journal = typeof leaf === "string" && leaf ? activeModelJournal(result.entries, leaf) : null;
  if (typeof leaf !== "string" || !journal) throw new Error(`Lane ${laneId} native default model journal is unavailable`);
  const saved = journal.changes.find(change => (change.role ?? "default") === "default");
  if (saved?.resolvedModelIsFallback === true) throw new Error(`Lane ${laneId} native default journal contains an ambiguous fallback entry`);
  let selected: LaneModel | undefined;
  if (saved) {
    const index = journal.branch.findIndex(entry => entry.id === saved.id);
    const receipt = journal.branch.slice(0, index).find(entry => entry.type === "custom"
      && entry.customType === LANE_MODEL_PROMOTION_RECEIPT && record(entry.data).entryId === saved.id);
    if (receipt) {
      const data = record(receipt.data);
      const exact = data.model;
      if (!isLaneModel(exact) || data.selector !== saved.model
        || saved.model !== laneModelArgument(exact) && !saved.model.startsWith(`${laneModelArgument(exact)}@`))
        throw new Error(`Lane ${laneId} native model promotion receipt does not match its default journal entry`);
      selected = exact;
    } else {
      const legacy = recordedModel(saved.model, catalog);
      if (!legacy || catalog.some(candidate => isLaneModel(candidate) && !sameLaneModel(candidate, legacy)
        && laneModelArgument(candidate) === laneModelArgument(legacy))) {
        throw new Error(`Lane ${laneId} cannot resolve its journaled native default model unambiguously`);
      }
      selected = legacy;
    }
  }
  return { leaf, selected };
}

/** Check the fallback chain on the exact active branch, not unrelated journal rows. */
export function recordedFallbackEvidence(evidence: Record<string, unknown>, models: {
  readonly configured: LaneModel;
  readonly actual: LaneModel;
  readonly catalog: unknown[];
}, after?: string): { readonly leaf: string; readonly entryId: string } | null {
  const leaf = evidence.leafId;
  if (typeof leaf !== "string" || !leaf) return null;
  const changes = activeModelJournal(evidence.entries, leaf, after)?.changes;
  if (!changes) return null;
  // Consecutive flagged retry hops belong to the same configured selection.
  // An unflagged ephemeral change can also be context promotion, not retry.
  const firstNonRetry = changes.findIndex(change =>
    change.role !== EPHEMERAL_MODEL_CHANGE_ROLE || change.resolvedModelIsFallback !== true);
  if (firstNonRetry < 1) return null;
  const configured = changes[firstNonRetry];
  // A fresh flagged retry may follow an unflagged row on the configured
  // model after cooldown. That row is only the source, never the evidence
  // that another model is permitted now.
  if ((configured.role !== undefined && configured.role !== "default" && configured.role !== EPHEMERAL_MODEL_CHANGE_ROLE)
    || configured.resolvedModelIsFallback === true
    || !sameLaneModel(recordedModel(configured.model, models.catalog), models.configured)) return null;
  const latest = changes[0];
  if (!sameLaneModel(recordedModel(latest.model, models.catalog), models.actual)) return null;
  return { leaf, entryId: latest.id };
}
