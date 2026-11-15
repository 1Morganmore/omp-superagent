import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, watch } from "node:fs";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { nativeRequestEnvelope } from "./native-request-envelope";

export const autonomyModel = { provider: "autonomy-native", id: "local" } as const;

/** Only the provider is scripted; native goals, tools, abort and RPC execution are real. */
export default function autonomyFixture(pi: ExtensionAPI): void {
  let run = 0;
  let created = false;
  let completed = false;
  let held = false;
  let headTodoStep = 0;
  const progressStarted = new Set<string>();
  pi.on("agent_start", () => { run++; });
  pi.on("session_before_compact", async (event, ctx) => {
    if (event.customInstructions === "queue-stop-restoration") {
      const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
      if (!(session instanceof pi.pi.AgentSession)) throw new Error("Native compact queue fixture requires its root session");
      // Admit through the real public SDK while native compact owns the
      // disconnected session. These messages predate the owner's stop fence.
      await session.steer("Already admitted steering\nKeep the exact first draft.");
      await session.steer("Already admitted second steering: preserve ordering.");
      await session.followUp("Already admitted follow-up\nKeep the exact final draft.");
      session.agent.followUp({
        role: "custom", customType: "fixture-stop-context", content: "Preserve admitted internal context without a model turn.",
        display: true, attribution: "agent", timestamp: Date.now(),
      });
      if (session.queuedMessageCount !== 4) throw new Error("Native compact did not retain all admitted messages");
    }
    await ctx.ui.confirm("Autonomy serial barrier", "Release the isolated native compaction command.");
    return { cancel: true };
  });
  pi.registerTool({
    name: "fixture_progress_barrier", label: "Wait for native progress observation",
    description: "Wait for the isolated fixture to observe delivery, then finish the real native tool.",
    approval: "read", loadMode: "essential",
    parameters: Type.Object({ key: Type.Union([Type.Literal("head"), Type.Literal("lane")]) }),
    async execute(_id, params, signal) {
      const directory = process.env.OMP_AUTONOMY_PROGRESS_BARRIER_DIR;
      if (!directory || !signal) throw new Error("Native progress barrier requires fixture isolation and an AbortSignal");
      const filename = `${params.key}-progress.release`;
      const release = path.join(directory, filename);
      const barrier = Promise.withResolvers<void>();
      const watcher = watch(directory, (_event, changed) => {
        if (changed?.toString() === filename && existsSync(release)) barrier.resolve();
      });
      const abort = () => barrier.reject(new Error("Native progress barrier interrupted"));
      const timer = setTimeout(() => barrier.reject(new Error("Native progress barrier was not released")), 40_000);
      watcher.on("error", barrier.reject);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      if (existsSync(release)) barrier.resolve();
      try {
        await barrier.promise;
        return { content: [{ type: "text", text: `NATIVE_PROGRESS_BARRIER_RELEASED ${params.key}` }], details: {} };
      } finally {
        clearTimeout(timer);
        watcher.close();
        signal.removeEventListener("abort", abort);
      }
    },
  });
  pi.registerTool({
    name: "fixture_autonomy_hold", label: "Hold owned native work",
    description: "Hold this native tool until the owner interrupts it.",
    approval: "read", loadMode: "essential", parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (!signal) throw new Error("Native hold requires the actual execution AbortSignal");
      held = true;
      const stopped = Promise.withResolvers<void>();
      const abort = () => stopped.resolve();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        await stopped.promise;
        return { content: [{ type: "text", text: "Native owned work interrupted" }], details: {} };
      } finally { signal.removeEventListener("abort", abort); }
    },
  });
  const mock = createMockModel({
    ...autonomyModel,
    handler: context => {
      const envelope = context.messages.flatMap(message => {
        if (message.role !== "user") return [];
        const text = typeof message.content === "string" ? message.content
          : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const parsed = nativeRequestEnvelope(text);
        return parsed ? [{ ...parsed, text }] : [];
      }).at(-1);
      if (!envelope) throw new Error("Native autonomy model requires the production source envelope");
      if (process.env.OMP_SUPERAGENT_ROLE !== "lane") {
        if (envelope.requestId.startsWith("progress:") && envelope.text.includes("LANE_PROGRESS 500"))
          return { content: ["HEAD_RELAYED_LANE_PROGRESS 500"] };
        if (envelope.requestId === "report:handoff:500:lane") {
          if (!envelope.text.includes("LANE_FINAL 500")) throw new Error("Final lane report reused intermediate prose");
          return { content: ["HEAD_RELAYED_LANE_FINAL 500"] };
        }
        if (envelope.text.includes("[head-progress]")) {
          if (!progressStarted.has("head")) {
            progressStarted.add("head");
            return { content: [
              { type: "thinking", thinking: "PRIVATE_HEAD_PROGRESS_REASONING" },
              "HEAD_PROGRESS 052: the native tool is still running.",
              { type: "toolCall", name: "fixture_progress_barrier", arguments: { key: "head" } },
            ] };
          }
          const result = context.messages.at(-1);
          if (result?.role !== "toolResult" || result.toolName !== "fixture_progress_barrier" || result.isError)
            throw new Error("Direct head final requires the real native barrier result");
          return { content: ["HEAD_FINAL 052"] };
        }
        if (envelope.text.includes("[head-todo-empty-tail]")) {
          const task = `Verify retained head reply ${envelope.sourceId}`;
          if (headTodoStep === 0) {
            if (!context.tools?.some(tool => tool.name === "todo")) throw new Error("Head did not expose the native todo tool");
            headTodoStep = 1;
            return { content: [{ type: "toolCall", name: "todo", arguments: {
              op: "init", list: [{ phase: "Head reply retention", items: [task] }],
            } }] };
          }
          if (headTodoStep === 1) {
            const result = context.messages.at(-1);
            if (result?.role !== "toolResult" || result.toolName !== "todo" || result.isError)
              throw new Error("The actual native todo creation did not succeed");
            headTodoStep = 2;
            return { content: [`HEAD_TODO_REPLY ${envelope.sourceId}`] };
          }
          if (!context.messages.some(message => {
            if (message.role !== "developer") return false;
            const text = typeof message.content === "string" ? message.content
              : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
            return text.includes("You stopped with 1 incomplete todo item(s):") && text.includes(task);
          }))
            throw new Error("Empty head reply requires the actual native incomplete-todo reminder");
          headTodoStep = 3;
          return { content: [], stopReason: "stop" };
        }
        // The next ordinary head request removes this scenario's native todo
        // through the actual tool before returning its own, unrelated answer.
        if (headTodoStep === 3) {
          headTodoStep = 4;
          return { content: [{ type: "toolCall", name: "todo", arguments: { op: "rm" } }] };
        }
        if (headTodoStep === 4) {
          const result = context.messages.at(-1);
          if (result?.role !== "toolResult" || result.toolName !== "todo" || result.isError)
            throw new Error("The actual native todo cleanup did not succeed");
          headTodoStep = 5;
        }
        return { content: [`HEAD ${envelope.requestId}`] };
      }
      if (envelope.text.includes("[lane-progress]")) {
        if (!progressStarted.has("lane")) {
          progressStarted.add("lane");
          return { content: [
            { type: "thinking", thinking: "PRIVATE_LANE_PROGRESS_REASONING" },
            "LANE_PROGRESS 500: the native tool is still running.",
            { type: "toolCall", name: "fixture_progress_barrier", arguments: { key: "lane" } },
          ] };
        }
        const result = context.messages.at(-1);
        if (result?.role !== "toolResult" || result.toolName !== "fixture_progress_barrier" || result.isError)
          throw new Error("Lane final requires the real native barrier result");
        return { content: ["LANE_FINAL 500"] };
      }
      if (envelope.text.includes("[resume-correction]")) {
        const attachment = /local file ([^;\n]+);/.exec(envelope.text)?.[1];
        if (!attachment || readFileSync(attachment, "utf8") !== "Apply the exact owner correction.\n")
          throw new Error("The original correction attachment was not delivered");
        return { content: [`CORRECTION_APPLIED ${envelope.sourceId}`] };
      }
      if (envelope.text.includes("[goal-disabled]")) {
        if (context.tools?.some(tool => tool.name === "goal")) throw new Error("Managed role bypassed goal.enabled=false");
        return { content: ["NATIVE_GOAL_DISABLED"] };
      }
      if (!created) {
        if (!context.tools?.some(tool => tool.name === "goal")) throw new Error("Managed role did not expose the native goal tool");
        created = true;
        return { content: [{ type: "toolCall", name: "goal", arguments: {
          op: "create", objective: `Verify entrusted objective ${envelope.sourceId} through two native turns`,
        } }] };
      }
      if (context.messages.some(message => message.role === "toolResult" && message.toolName === "goal" && message.isError))
        throw new Error("A real native goal operation failed");
      if (run === 1) return { content: ["Milestone reached; useful objective work remains."] };
      if (envelope.text.includes("[pause-goal]") && !held)
        return { content: [{ type: "toolCall", name: "fixture_autonomy_hold", arguments: {} }] };
      if (!completed) {
        completed = true;
        return { content: [{ type: "toolCall", name: "goal", arguments: { op: "complete" } }] };
      }
      return { content: [`AUTONOMY_COMPLETE ${envelope.sourceId}; runs=${run}`] };
    },
  });
  pi.registerProvider(autonomyModel.provider, {
    baseUrl: "mock://autonomy-native", api: autonomyModel.provider, apiKey: "local-test-only",
    streamSimple: (model, context, options) => mock.stream(model, context, options),
    models: [{ id: autonomyModel.id, name: "Local native autonomy proof", kind: "chat", reasoning: false,
      input: ["text"], contextWindow: 200_000, maxTokens: 32_768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
}
