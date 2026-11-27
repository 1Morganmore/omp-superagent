/** Only model transport and the explicit tool barrier are fixtures; OMP owns execution. */
import { createConnection } from "node:net";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { nativeRequestEnvelope } from "./native-request-envelope";

export const steeringModel = { provider: "steering-native", id: "local" } as const;
export const steeringRecord = "omp-superagent-native-steering";
export const steeringJobGate = ".release-steering-job";
export const steeringContinuationJobGate = ".release-steering-continuation-job";

export default function steeringFixture(pi: ExtensionAPI): void {
  let run = 0;
  let sessionId = "";
  const entered = new Set<string>();
  pi.on("session_start", (_event, ctx) => { sessionId = ctx.sessionManager.getSessionId(); });
  pi.on("agent_start", () => { run++; });
  pi.registerTool({
    name: "fixture_steering_barrier", label: "Native steering proof barrier",
    description: "Wait for the private test coordinator to release this real native tool invocation.",
    approval: "read", loadMode: "essential",
    parameters: Type.Object({ token: Type.String({ minLength: 1 }) }),
    async execute(_id, { token }, signal) {
      const socketPath = process.env.OMP_TEST_STEERING_BARRIER;
      if (!socketPath || !signal) throw new Error("Native steering barrier requires a private socket and native AbortSignal");
      entered.add(token);
      const gate = Promise.withResolvers<"released" | "aborted">();
      const socket = createConnection(socketPath);
      const aborted = () => gate.resolve("aborted");
      socket.once("error", gate.reject);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ token, run, sessionId, pid: process.pid })}\n`);
      });
      let response = "";
      socket.on("data", bytes => {
        response += bytes.toString();
        if (response.includes("\n")) {
          if (response !== "release\n") gate.reject(new Error("Unexpected private native barrier response"));
          else gate.resolve("released");
        }
      });
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      try {
        const phase = await gate.promise;
        pi.appendEntry(steeringRecord, { phase: `tool-${phase}`, token, run, sessionId });
        return { content: [{ type: "text", text: `Native barrier ${token}: ${phase}` }], details: {} };
      } finally {
        signal.removeEventListener("abort", aborted);
        socket.destroy();
      }
    },
  });
  const mock = createMockModel({
    ...steeringModel,
    handler: context => {
      const users = context.messages.flatMap(message => {
        if (message.role !== "user") return [];
        const text = typeof message.content === "string" ? message.content
          : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const envelope = nativeRequestEnvelope(text);
        return envelope ? [{ ...envelope, text }] : [];
      });
      const latest = users.at(-1);
      if (!latest) throw new Error("Native steering model did not receive a runtime-authored user envelope");
      const snapshot = { run, sessionId, requestId: latest.requestId,
        requestIds: users.map(user => user.requestId), sourceIds: users.map(user => user.sourceId) };
      const toolResult = (id: string) => context.messages.some(message => {
        if (message.role !== "toolResult" || message.toolCallId !== id) return false;
        if (message.isError) throw new Error(`Native steering fixture tool failed: ${id}`);
        return true;
      });
      if (latest.text.includes("[native-barrier:head-live]")) {
        if (!toolResult("steering-goal-create")) return {
          content: [{ type: "toolCall", id: "steering-goal-create", name: "goal", arguments: {
            op: "create", objective: "Receive the two authorized follow-ups, then give one consolidated reply.",
          } }],
        };
        if (!toolResult("steering-job")) return {
          content: [{ type: "toolCall", id: "steering-job", name: "bash", arguments: { async: true, timeout: 45,
            command: `while [ ! -e '${steeringJobGate}' ]; do /bin/sleep 0.05; done`,
          } }],
        };
      }
      if (latest.text.includes("[native-steering-finish]")) {
        if (!toolResult("steering-goal-complete")) return {
          content: [{ type: "toolCall", id: "steering-goal-complete", name: "goal", arguments: { op: "complete" } }],
        };
        if (run === 2 && !toolResult("steering-continuation-job")) return {
          content: [{ type: "toolCall", id: "steering-continuation-job", name: "bash", arguments: { async: true, timeout: 45,
            command: `while [ ! -e '${steeringContinuationJobGate}' ]; do /bin/sleep 0.05; done`,
          } }],
        };
      }
      // Head intake explicitly authorizes fixture-driven public lane operations.
      // A meaningful acknowledgment completes normally, without native empty-answer retries.
      if (latest.requestId === latest.sourceId && latest.text.includes("[native-delegate]")) {
        pi.appendEntry(steeringRecord, { phase: "delegate", ...snapshot });
        return { content: [`Native dispatch acknowledged ${latest.sourceId}; awaiting explicit lane coordination.`] };
      }
      const token = /\[native-barrier:([a-z0-9-]+)\]/.exec(latest.text)?.[1];
      if (token && !entered.has(token)) {
        pi.appendEntry(steeringRecord, { phase: "tool-request", token, ...snapshot });
        return { content: [{ type: "toolCall", name: "fixture_steering_barrier", arguments: { token } }] };
      }
      pi.appendEntry(steeringRecord, { phase: "answer", ...snapshot });
      return { content: [`Native final ${latest.requestId}; sources ${snapshot.sourceIds.join(",")}`],
        usage: { input: 37, output: 7, totalTokens: 44 } };
    },
  });
  pi.registerProvider(steeringModel.provider, {
    baseUrl: "mock://steering-native", api: steeringModel.provider, apiKey: "local-test-only",
    streamSimple: (model, context, options) => mock.stream(model, context, options),
    models: [{ id: steeringModel.id, name: "Local native steering proof", kind: "chat", reasoning: false,
      input: ["text"], contextWindow: 200_000, maxTokens: 32_768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
}
