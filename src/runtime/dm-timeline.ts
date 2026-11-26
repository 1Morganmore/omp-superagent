import { createHash } from "node:crypto";
import { physicalRoute, physicalRouteKey, type Inbound, type Route, type StorePort } from "../contracts";
import { compareMessageIds } from "../routing/message-order";

interface DmBoundary {
  eventId: string;
  messageId: string;
  receivedAt: number;
  topicId: string | null;
}
interface DmCommandBoundary {
  eventId: string;
  invocationId: string;
  anchorMessageId: string | null;
  insertionOrder: number;
  topicId: string | null;
}

export function newLogicalTopicId(sourceId: string): string {
  return `topic-${createHash("sha256").update(sourceId).digest("hex").slice(0, 24)}`;
}

export function eventOrderId(input: Inbound): string | null {
  if (typeof input.messageId === "string" && input.messageId.length) {
    if (input.route.platform === "slack" && compareMessageIds("slack", input.messageId, input.messageId) === null) throw new Error("Cannot order a Slack input without an actual timestamp");
    return input.messageId;
  }
  if (input.messageId === null && input.route.platform === "discord" && typeof input.interactionId === "string" && /^[1-9]\d{0,19}$/.test(input.interactionId)) {
    return input.interactionId;
  }
  if (input.messageId === null && input.route.platform === "slack" && input.route.threadId === null
    && typeof input.invocationId === "string" && /^[a-f0-9]{64}$/.test(input.invocationId)) return null;
  throw new Error("Inbound event requires a real message ID, Discord interaction snowflake, or scoped Slack invocation");
}

export class DmTimeline {
  constructor(private readonly store: Pick<StorePort, "getMeta" | "admittedMessageIds" | "input">) {}

  admit(input: Inbound, eventId: string | null, commandBlocked: boolean): { input: Inbound; metadata: Record<string, string> } {
    if (input.route.platform === "slack") return this.slackDmAdmission(input);
    let metadata: Record<string, string> = {};
    if (eventId === null) throw new Error("Cannot order this DM input");
    const physical = physicalRoute(input.route);
    const command = commandBlocked ? "" : input.text.trim();
    const boundaries = this.topicBoundaries(physical);
    const originalBoundary = boundaries.find(boundary => {
      const order = compareMessageIds(physical.platform, boundary.messageId, eventId);
      if (order === null) throw new Error("Cannot order this message against the DM topic timeline");
      return order === 0;
    });
    let topicId: string | null;
    if (originalBoundary) {
      // Edit events are new inputs, not permission to rewrite the original
      // command boundary or switch today's topic selection back in time.
      topicId = originalBoundary.topicId;
      const original = this.store.input(originalBoundary.eventId)?.text.trim();
      if (original !== undefined && (/^\/new(?:\s|$)/.test(original) || original === "/main")) {
        metadata = { [`dm:control-edit:${input.id}`]: "true" };
      }
    } else if (/^\/new(?:\s|$)/.test(command)) {
      topicId = newLogicalTopicId(input.id);
      metadata = this.topicMetadata(input, topicId);
    } else if (command === "/main") {
      topicId = null;
      metadata = this.topicMetadata(input, null);
    } else {
      const eligible = boundaries.filter(boundary => {
        const order = compareMessageIds(physical.platform, boundary.messageId, eventId);
        if (order === null) throw new Error("Cannot order this message against the DM topic timeline");
        return order <= 0;
      });
      topicId = eligible.length ? eligible[eligible.length - 1]!.topicId
        : boundaries.length ? null : this.store.getMeta(`dm:active:${physicalRouteKey(physical)}`);
    }
    return { input: { ...input, route: topicId ? { ...physical, topicId } : physical }, metadata };
  }

  isExplicitTopic(route: Route): boolean {
    if (!route.topicId || route.guildId !== null || route.threadId !== null) return false;
    const boundary = this.topicBoundaries(route).find(item => item.topicId === route.topicId)
      ?? (route.platform === "slack" ? this.commandBoundaries(route).find(item => item.topicId === route.topicId) : undefined);
    return boundary !== undefined && this.store.input(boundary.eventId)?.text.trim() === "/new";
  }

  private topicBoundaries(route: Route): DmBoundary[] {
    return JSON.parse(this.store.getMeta(`dm:boundaries:${physicalRouteKey(route)}`) ?? "[]") as DmBoundary[];
  }

  private commandBoundaries(route: Route): DmCommandBoundary[] {
    return JSON.parse(this.store.getMeta(`dm:command-boundaries:${physicalRouteKey(route)}`) ?? "[]") as DmCommandBoundary[];
  }

  private slackTimeline(route: Route, messages = this.topicBoundaries(route), commands = this.commandBoundaries(route)) {
    return [
      ...messages.map(boundary => ({ anchor: boundary.messageId as string | null, command: false, order: 0, topicId: boundary.topicId })),
      ...commands.map(boundary => ({ anchor: boundary.anchorMessageId, command: true, order: boundary.insertionOrder, topicId: boundary.topicId })),
    ].sort((left, right) => {
      const order = left.anchor === null ? right.anchor === null ? 0 : -1 : right.anchor === null ? 1
        : compareMessageIds("slack", left.anchor, right.anchor);
      if (order === null) throw new Error("Cannot order the persisted Slack DM topic timeline");
      return order || Number(left.command) - Number(right.command) || left.order - right.order;
    });
  }

  private slackAnchor(input: Inbound): string | null {
    const stored = this.store.getMeta(`dm:invocation-anchor:${input.id}`);
    if (stored !== null) {
      const anchor = JSON.parse(stored) as { invocationId: string; anchorMessageId: string | null };
      if (anchor.invocationId !== input.invocationId) throw new Error("Slack invocation anchor identity conflict");
      return anchor.anchorMessageId;
    }
    let latest: string | null = null;
    for (const messageId of this.store.admittedMessageIds(input.route)) {
      const order = compareMessageIds("slack", messageId, latest ?? messageId);
      if (order === null) throw new Error("Cannot order durable Slack owner messages");
      if (latest === null || order > 0) latest = messageId;
    }
    return latest;
  }

  private slackDmAdmission(input: Inbound): { input: Inbound; metadata: Record<string, string> } {
    const physical = physicalRoute(input.route);
    const command = input.text.trim();
    const control = /^\/new(?:\s|$)/.test(command) || command === "/main";
    const anchorMessageId = input.messageId === null ? this.slackAnchor(input) : undefined;
    let metadata: Record<string, string> = {};
    let topicId: string | null;
    if (anchorMessageId !== undefined) {
      metadata[`dm:invocation-anchor:${input.id}`] = JSON.stringify({ invocationId: input.invocationId, anchorMessageId });
    }
    if (control) {
      topicId = command === "/main" ? null : newLogicalTopicId(input.id);
      metadata = { ...metadata, ...this.topicMetadata(input, topicId, anchorMessageId) };
    } else if (input.messageId === null) {
      topicId = this.store.getMeta(`dm:active:${physicalRouteKey(physical)}`) || null;
    } else {
      const timeline = this.slackTimeline(physical);
      const eligible = timeline.filter(boundary => {
        if (boundary.anchor === null) return true;
        const order = compareMessageIds("slack", boundary.anchor, input.messageId!);
        if (order === null) throw new Error("Cannot order this message against the DM topic timeline");
        return boundary.command ? order < 0 : order <= 0;
      });
      topicId = eligible.length ? eligible[eligible.length - 1]!.topicId : timeline.length ? null
        : this.store.getMeta(`dm:active:${physicalRouteKey(physical)}`) || null;
    }
    return { input: { ...input, route: topicId ? { ...physical, topicId } : physical }, metadata };
  }

  topicMetadata(input: Inbound, topicId: string | null, anchorMessageId?: string | null): Record<string, string> {
    const eventId = eventOrderId(input);
    if (eventId === null) {
      const boundaries = this.commandBoundaries(input.route);
      const existing = boundaries.find(boundary => boundary.invocationId === input.invocationId);
      if (existing) {
        if (existing.eventId !== input.id || existing.topicId !== topicId) throw new Error("Slack command boundary identity conflict");
        return {}; // Reusing an invocation never resets the active selection.
      }
      // Slack has no slash clock. This is observed-admission order after the
      // latest durable real owner message, not cross-connection chronology.
      boundaries.push({ eventId: input.id, invocationId: input.invocationId!,
        anchorMessageId: anchorMessageId === undefined ? this.slackAnchor(input) : anchorMessageId,
        insertionOrder: (boundaries[boundaries.length - 1]?.insertionOrder ?? 0) + 1, topicId });
      const timeline = this.slackTimeline(input.route, undefined, boundaries);
      const identity = physicalRouteKey(input.route);
      return { [`dm:command-boundaries:${identity}`]: JSON.stringify(boundaries),
        [`dm:active:${identity}`]: timeline[timeline.length - 1]!.topicId ?? "" };
    }
    if (compareMessageIds(input.route.platform, eventId, eventId) === null) {
      throw new Error("A DM topic boundary requires an authoritative platform event ID");
    }
    const boundaries = this.topicBoundaries(input.route);
    for (const boundary of boundaries) {
      const order = compareMessageIds(input.route.platform, boundary.messageId, eventId);
      if (order === null) throw new Error("Cannot order the persisted DM topic timeline");
      if (order === 0 && boundary.topicId !== topicId) throw new Error("A message cannot establish conflicting DM topic boundaries");
    }
    if (!boundaries.some(boundary => boundary.eventId === input.id)) boundaries.push({
      eventId: input.id, messageId: eventId, receivedAt: input.receivedAt, topicId,
    });
    boundaries.sort((left, right) => {
      const order = compareMessageIds(input.route.platform, left.messageId, right.messageId);
      if (order === null) throw new Error("Cannot order the persisted DM topic timeline");
      return order;
    });
    const identity = physicalRouteKey(input.route);
    const active = input.route.platform === "slack" ? this.slackTimeline(input.route, boundaries).at(-1)!.topicId
      : boundaries[boundaries.length - 1]!.topicId;
    return {
      [`dm:boundaries:${identity}`]: JSON.stringify(boundaries),
      [`dm:active:${identity}`]: active ?? "",
    };
  }
}
