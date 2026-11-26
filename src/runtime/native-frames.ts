import type { DialogResponse, LaneModel, LanePresetSnapshot } from "../contracts";
import type { FastModeState } from "../omp/host-protocol";
import { laneQuotaExhausted } from "./head-recovery";

export interface RuntimeState {
  sessionFile?: string;
  sessionId: string;
  readonly journalCursorVersion?: 1;
  readonly replyVoiceVersion?: 1 | 2;
  readonly fastMode?: FastModeState;
  model?: LaneModel | null;
  thinkingLevel?: string;
  configuredThinkingLevel?: string | null;
  thinkingLevels?: readonly string[];
  isCompacting?: boolean;
  queuedMessageCount?: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  settingsScope?: "session" | "persistent";
  modelSettings?: LanePresetSnapshot;
  mutationHeld?: boolean;
  hostPid?: number;
  readonly instanceKey?: string;
  isSettled: boolean;
  isStreaming: boolean;
  hasPendingAsyncWork?: boolean;
  hasOwnedRunningWork?: boolean;
  headJobs?: { running: readonly string[]; awaitingOnly: boolean };
  pendingUiRequests?: Record<string, unknown>[];
  goal?: { enabled?: boolean; mode?: string; goal?: { id?: string; status?: string } } | null;
}
/** The production adapter is HostConnection; tests inject only its transport boundary. */
export interface RuntimeHost {
  assertPrReviewOnly?(cwd: string): Promise<void>;
  client: {
    getState(): Promise<RuntimeState>;
    abortAndRestoreQueue(): Promise<unknown>;
    getSubagents(): Promise<Array<{ id: string }>>;
    cancelSubagent(id: string): Promise<unknown>;
  };
  exited: Promise<unknown>;
  request(command: Record<string, unknown>, id?: string): Promise<unknown>;
  uiResponse(id: string, response: DialogResponse): void;
  onFrame(listener: (frame: Record<string, unknown>) => void): () => void;
  close(): Promise<void>;
}

export interface NativePromptResult {
  readonly status: string;
  readonly agentInvoked: boolean;
  readonly goalResume?: true;
  readonly quota?: true;
  readonly httpStatus?: number;
  readonly retryable?: boolean;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
export function successful(value: unknown, operation: string): Record<string, unknown> {
  const envelope = record(value);
  if (envelope.success !== true) throw new Error(`${operation} was not acknowledged by the native host`);
  return record(envelope.data);
}
export function nativePromptResult(frame: Record<string, unknown>): NativePromptResult {
  const result = { status: String(frame.status), agentInvoked: frame.agentInvoked === true };
  if (frame.status !== "error") return result;
  const error = record(frame.error);
  return { ...result, ...(laneQuotaExhausted(error) ? { quota: true } : {}),
    ...(typeof error.httpStatus === "number" && Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599
      ? { httpStatus: error.httpStatus } : {}),
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}) };
}

export function restartPromptReceipt(entries: unknown[], state: Pick<RuntimeState, "sessionId" | "sessionFile">, requestId: string): NativePromptResult | undefined {
  const receipt = entries.map(record).find(entry => entry.type === "custom" && entry.customType === "rpc_prompt_result"
    && record(entry.data).sessionId === state.sessionId && record(entry.data).sessionFile === state.sessionFile
    && record(record(entry.data).frame).id === requestId);
  const frame = record(record(receipt).data).frame;
  return frame ? nativePromptResult(record(frame)) : undefined;
}

function textSignature(part: unknown): { id?: string; phase?: "commentary" | "final_answer" } {
  const signature = record(part).textSignature;
  if (typeof signature !== "string") return {};
  try {
    const parsed = record(JSON.parse(signature));
    return parsed.v === 1 && typeof parsed.id === "string"
      ? { id: parsed.id, ...(parsed.phase === "commentary" || parsed.phase === "final_answer" ? { phase: parsed.phase } : {}) }
      : {};
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}
export function assistantText(value: unknown): string | null {
  const message = record(value);
  if (message.role !== "assistant" || !Array.isArray(message.content)) return null;
  const text = message.content.filter(part => record(part).type === "text"
    && textSignature(part).phase !== "commentary"
    && (message.stopReason !== "toolUse" || textSignature(part).phase === "final_answer"))
    .map(part => String(record(part).text ?? "")).join("");
  return text.trim() ? text : null;
}
export function assistantProgress(value: unknown): { text: string; identity: string } | null {
  const message = record(value);
  if (message.role !== "assistant" || !Array.isArray(message.content)
    || !["stop", "length", "toolUse"].includes(String(message.stopReason))) return null;
  const parts = message.content.filter(part => record(part).type === "text"
    && (textSignature(part).phase === "commentary"
      || message.stopReason === "toolUse" && textSignature(part).phase !== "final_answer"));
  const text = parts.map(part => String(record(part).text ?? "")).join("");
  if (!text.trim()) return null;
  const ids = parts.map(part => textSignature(part).id).filter((id): id is string => id !== undefined);
  return { text, identity: typeof message.id === "string" ? message.id : ids.length ? JSON.stringify(ids) : text };
}

export function headJobResults(message: Record<string, unknown>): Map<string, string> {
  const batch = new Map<string, string>();
  const jobs = record(message.details).jobs;
  if (!Array.isArray(jobs) || !jobs.length) return batch;
  const content = typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? message.content.filter(part => record(part).type === "text")
      .map(part => String(record(part).text ?? "")).join("") : "";
  for (const job of jobs) {
    const { jobId, status } = record(job);
    if (typeof jobId !== "string") { batch.set("", ""); continue; }
    batch.set(jobId, jobs.length === 1 && content.trim() ? content
      : `백그라운드 작업 ${jobId}: ${typeof status === "string" ? status : "결과 도착"}`);
  }
  return batch;
}
