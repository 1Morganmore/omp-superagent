import { isAbsolute, normalize } from "node:path";

export type LaneWaitTarget =
  | { kind: "tool" | "approval" | "job"; id: string; target: string }
  | { kind: "dependency"; target: string };

export interface LaneEvidence {
  kind: "file" | "tool";
  ref: string;
  fingerprint: string;
}

export interface LaneReport {
  status: "progress" | "waiting" | "resolved";
  summary: string;
  evidence: LaneEvidence[];
  waiting?: LaneWaitTarget;
}

export interface LaneReportEvent {
  type: "superagent-lane-report";
  sessionId: string;
  reportId: string;
  report: LaneReport;
}

export function laneWaitKey(waiting: LaneWaitTarget): string {
  return JSON.stringify([waiting.kind, waiting.kind === "dependency" ? waiting.target : waiting.id]);
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).every(key => names.includes(key));

export function isLaneWaitTarget(value: unknown): value is LaneWaitTarget {
  return record(value) && text(value.target) && (value.kind === "dependency"
    ? keys(value, ["kind", "target"])
    : ["tool", "approval", "job"].includes(value.kind as string) &&
      keys(value, ["kind", "id", "target"]) && text(value.id));
}

/** Parse only the structured native result, never receipt text or a claimed event in content. */
export function parseLaneReportResult(result: unknown): LaneReportEvent | null {
  try {
    if (!record(result) || result.isError === true || !record(result.details)) return null;
    const event = result.details;
    if (!keys(event, ["type", "sessionId", "reportId", "report"]) ||
        event.type !== "superagent-lane-report" || !text(event.sessionId) || !text(event.reportId) ||
        !record(event.report)) return null;
    const report = event.report;
    if (!keys(report, ["status", "summary", "evidence", "waiting"]) ||
        !["progress", "waiting", "resolved"].includes(report.status as string) ||
        !text(report.summary) || report.summary.length > 4000 || !Array.isArray(report.evidence) ||
        report.evidence.length > 32) return null;
    if (report.evidence.some(item => !record(item) || !keys(item, ["kind", "ref", "fingerprint"]) ||
        (item.kind !== "file" && item.kind !== "tool") || !text(item.ref) ||
        (item.kind === "file" && (!isAbsolute(item.ref) || normalize(item.ref) !== item.ref)) ||
        typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.fingerprint))) return null;
    if (report.status !== "waiting" && report.evidence.length === 0) return null;
    if (report.status === "progress") {
      if (Object.hasOwn(report, "waiting")) return null;
    } else if (!isLaneWaitTarget(report.waiting)) return null;
    return event as unknown as LaneReportEvent;
  } catch {
    // Malformed native details must not escape into the head's event loop.
    return null;
  }
}
