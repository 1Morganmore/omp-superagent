import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { decisionId } from "./decisions";
import { parseDialog } from "./dialog";

/** Structured owner questions use the native host's UI, never a second messenger path. */
export function registerDecisionAsk(pi: ExtensionAPI): void {
  if (!["head", "lane"].includes(process.env.OMP_SUPERAGENT_ROLE ?? "")) return;
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
    name: "decision_ask", label: "Ask an owner decision", approval: "read", loadMode: "essential",
    description: "Ask structured questions on this managed session's native UI. Returns a stable decision id and the actual submitted answers or cancellation, timeout, or chat state. Only explicit submitted answers are decisions; recommendations, timeouts and chat are not owner acceptance. No default answers, timeout, messenger routing, or automatic work resume.",
    parameters: Type.Object({
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
      const id = decisionId(ctx.sessionManager.getSessionId(), toolCallId);
      const dialog = parseDialog({ method: "ask", questions: Array.isArray(params.questions)
        ? params.questions.map((question, index) => ({ ...question, id: `${id}:${index}` })) : params.questions });
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
