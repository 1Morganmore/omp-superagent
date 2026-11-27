import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { decisionId } from "./decisions";
import { parseDialog } from "../messaging/dialog";

/** Structured owner questions use the native host's UI, never a second messenger path. */
export function registerDecisionAsk(pi: ExtensionAPI): void {
  const role = process.env.OMP_SUPERAGENT_ROLE;
  if (role !== "head" && role !== "lane") return;
  const restricted = "Owner decisions are restricted to the root managed HEAD or lane session";
  // Public extension ToolDefinition has no concurrency field. Reject overlap
  // instead of replacing the native host's single active dialog surface.
  let asking = false;
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind === "main") return;
    const active = pi.getActiveTools();
    if (active.includes("decision_ask")) await pi.setActiveTools(active.filter(name => name !== "decision_ask"));
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "decision_ask" && ctx.agent.kind !== "main") return { block: true, reason: restricted };
  });
  pi.registerTool({
    name: "decision_ask", label: "Request a tracked decision", approval: "read", loadMode: "essential",
    description: (role === "lane"
      ? "Use to: \"head\" for a coordination choice that needs HEAD's answer, even from a work topic. " +
        "Omit to for the normal recipient (topic: owner; manager handoff: HEAD). " +
        "HEAD may select an original option or escalate the same question to the owner. " +
        "An answer never grants execution approval or authority to change the assignment. "
      : "Ask the owner structured questions on this managed session's native UI. ") +
      "Returns a stable decision id and the actual submitted answers or cancellation, timeout, or chat state. Recommendations, timeouts and chat are not acceptance. No default answers, route override, or automatic work resume.",
    parameters: Type.Object({
      ...(role === "lane" ? { to: Type.Optional(Type.Literal("head")) } : {}),
      questions: Type.Array(Type.Object({
        question: Type.String(),
        header: Type.Optional(Type.String()),
        options: Type.Array(Type.Object({
          label: Type.String({ minLength: 1 }),
          description: Type.Optional(Type.String()),
          preview: Type.Optional(Type.String()),
        }, { additionalProperties: false })),
        multi: Type.Optional(Type.Boolean()),
        recommended: Type.Optional(Type.Integer({ minimum: 0 })),
      }, { additionalProperties: false }), { minItems: 1 }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.agent.kind !== "main") throw new Error(restricted);
      if (params.to !== undefined && (role !== "lane" || params.to !== "head"))
        throw new Error("Only a managed lane can direct a coordination question to HEAD");
      const id = decisionId(ctx.sessionManager.getSessionId(), toolCallId);
      const prefix = role === "lane" && params.to === "head" ? `${id}:head` : id;
      const dialog = parseDialog({ method: "ask", questions: Array.isArray(params.questions)
        ? params.questions.map((question, index) => ({ ...question, id: `${prefix}:${index}` })) : params.questions });
      if (dialog.method !== "ask") throw new Error("Expected structured decision questions");
      if (!ctx.ui.askDialog) throw new Error("Native structured decision UI is unavailable on this host");
      if (asking) throw new Error("An owner decision dialog is already pending in this native session");
      asking = true;
      try {
        const answer = await ctx.ui.askDialog(dialog.questions, { signal });
        const value = answer === undefined ? { id, status: "cancelled" }
          : answer.kind === "chat" ? { id, status: "chat" }
          : { id, status: answer.results.some(item => item.timedOut) ? "timed_out" : "submitted", answers: answer.results };
        return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
      } finally { asking = false; }
    },
  });
}
