import { createHash } from "node:crypto";
import { routeKey, type Approval } from "./contracts";

/** Existing cards and persisted dialog progress must keep this exact identity. */
export function approvalCardToken(approval: Approval): string {
  return createHash("sha256")
    .update(JSON.stringify([approval.id, approval.generation, approval.target, approval.requestId, routeKey(approval.route)]))
    .digest("hex").slice(0, 24);
}

/** An ambiguous transport mutation must never be retried as a known rejection. */
export class DeliveryError extends Error {
  constructor(message: string, public readonly certainty: "rejected" | "uncertain" = "uncertain", public readonly retryAfterMs?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeliveryError";
  }
}
