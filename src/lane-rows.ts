import type { Database } from "bun:sqlite";
import type { Lane } from "./contracts";

export function toLane(row: { readonly data: string }): Lane {
  const lane = JSON.parse(row.data) as Lane;
  return { ...lane, model: lane.model ?? null, modelReason: lane.modelReason ?? null,
    modelPreset: lane.modelPreset ?? null, modelPresetSnapshot: lane.modelPresetSnapshot ?? null };
}

export function readLaneRows(db: Database): Lane[] {
  return db.query<{ data: string }, []>("SELECT data FROM lanes ORDER BY rowid").all().map(toLane);
}
