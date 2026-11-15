// Finite native prompt-composition gate, not a model turn or workflow execution.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getBundledModel, getBundledProviders } from "../.upstream/omp/packages/catalog/src/models";
import { ModelRegistry } from "../.upstream/omp/packages/coding-agent/src/config/model-registry";
import { Settings } from "../.upstream/omp/packages/coding-agent/src/config/settings";
import { listPackageExtensionModules, loadExtensions } from "../.upstream/omp/packages/coding-agent/src/extensibility/extensions/loader";
import { ExtensionRunner } from "../.upstream/omp/packages/coding-agent/src/extensibility/extensions/runner";
import nativeSystemPromptTemplate from "../.upstream/omp/packages/coding-agent/src/prompts/system/system-prompt.md" with { type: "text" };
import { AuthStorage } from "../.upstream/omp/packages/coding-agent/src/session/auth-storage";
import { SessionManager } from "../.upstream/omp/packages/coding-agent/src/session/session-manager";
import { buildSystemPrompt } from "../.upstream/omp/packages/coding-agent/src/system-prompt";

const packagePath = process.argv[2];
if (!packagePath) throw new Error("Managed ULW probe requires a package path");
const home = process.env.HOME;
const agentDir = process.env.PI_CODING_AGENT_DIR;
assert(home && agentDir && resolve(dirname(agentDir)) === resolve(home) && resolve(process.cwd()) === resolve(home),
  "Managed ULW probe requires the updater's isolated HOME, agent directory and working directory");
let networkAttempts = 0;
const refuseNetwork = () => { networkAttempts++; throw new Error("Managed ULW probe forbids network and provider calls"); };
globalThis.fetch = Object.assign(async () => refuseNetwork(), { preconnect: refuseNetwork });

const modules = await listPackageExtensionModules([packagePath], process.cwd(), { plugins: false });
if (!modules.length) throw new Error("Managed ULW has no discoverable extension");
// Use the same supported identity as the native composition fixture, but take
// every model field from the pinned catalog rather than inventing a provider.
const model = getBundledModel("xai", "grok-4.5");
assert(model, "Pinned OMP catalog is missing the native composition model xai/grok-4.5");
await mkdir(agentDir, { recursive: true, mode: 0o700 });
const settings = await Settings.loadIsolated({
  cwd: home, agentDir, inMemory: true,
  overrides: {
    disabledProviders: [...new Set([...getBundledProviders(), "ollama", "lm-studio", "llama.cpp", "apple"])],
    "memory.backend": "off", "autolearn.enabled": false,
  },
});
const authStorage = await AuthStorage.create(":memory:");
try {
  const sessionManager = SessionManager.inMemory(home);
  const loaded = await loadExtensions(modules.map(module => module.path), home);
  assert.deepEqual(loaded.errors, [], "Native OMP rejected managed ULW");
  assert.equal(loaded.extensions.length, modules.length, "Native OMP must load every advertised extension");
  // Render the pinned bundled template through OMP, with no ambient discovery,
  // tools, memory backend, SDK Agent, services, or provider/model execution.
  const { systemPrompt: nativeBase } = await buildSystemPrompt({
    cwd: home, model: `${model.provider}/${model.id}`, systemPromptTemplate: nativeSystemPromptTemplate,
    contextFiles: [], noContextFiles: true, rules: [], skills: [],
    toolNames: [], activeRepoContext: null, personality: "none",
  });
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, home, sessionManager,
    new ModelRegistry(authStorage, join(home, "models.yml"), { settings }), undefined, settings);
  const errors: unknown[] = [];
  const refuseEffect = (): never => {
    const error = new Error("Managed ULW prompt probe forbids agent, tool, service and session-control effects");
    errors.push(error);
    throw error;
  };
  let currentSystemPrompt = nativeBase;
  // This is a prompt-only host, not a fake agent: only in-memory journal writes
  // and read-only context exist. Unsupported effects fail the activation gate.
  runner.initialize({
    sendMessage: refuseEffect, sendUserMessage: refuseEffect,
    appendEntry: (customType, data) => { sessionManager.appendCustomEntry(customType, data); },
    setLabel: (targetId, label) => { sessionManager.appendLabelChange(targetId, label); },
    getActiveTools: () => [], getAllTools: () => [], setActiveTools: refuseEffect,
    getCommands: refuseEffect, setModel: refuseEffect,
    getThinkingLevel: () => undefined, setThinkingLevel: refuseEffect,
    getServiceTiers: () => ({}), setServiceTier: refuseEffect,
    getSessionName: () => sessionManager.getSessionName(), setSessionName: refuseEffect,
  }, {
    getModel: () => model, isIdle: () => true, hasPendingMessages: () => false,
    abort: refuseEffect, shutdown: refuseEffect, compact: refuseEffect,
    getContextUsage: () => undefined, getSystemPrompt: () => currentSystemPrompt,
    runEphemeralTurn: refuseEffect, startLive: refuseEffect,
  });
  runner.onError(error => { errors.push(error); });
  try {
    await runner.emit({ type: "session_start" });
    assert(nativeBase[0] && nativeBase[0].length > 500, "Probe must use OMP's actual rendered native prompt");
    const nativeRole = /\n[§⁂] Role\n([\s\S]*?)\n[§⁂] Runtime\n/.exec(nativeBase[0])?.[1];
    assert(nativeRole && nativeRole.trim(), "Native prompt has no recognizable role to replace");
    const initialBranch = structuredClone(sessionManager.getBranch());
    const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
    const check = (blocks: string[], workflow: boolean) => {
      const text = blocks.join("\n\n");
      assert.equal(occurrences(text, "<omp-model-preset>"), 1, "Expected exactly one applied model preset");
      assert.equal(occurrences(text, "</omp-model-preset>"), 1, "Expected one complete model preset");
      const preset = /<omp-model-preset>([\s\S]*?)<\/omp-model-preset>/.exec(text)?.[1];
      assert(preset && preset.trim().length > 200, "Model preset must contain working instructions, not an empty marker");
      assert.match(preset, /Grok 4\.5/, "Supported model-specific instructions must actually be selected");
      assert(!text.includes(nativeRole), "Model preset did not replace the native role");
      assert.equal(occurrences(text, "<omp-ulw-policy>"), workflow ? 1 : 0,
        workflow ? "Expected exactly one explicitly activated ULW policy" : "Model-profile loading must not activate ULW");
      assert.equal(occurrences(text, "</omp-ulw-policy>"), workflow ? 1 : 0);
      if (workflow) {
        const policy = /<omp-ulw-policy>\s*<ultrawork-mode>([\s\S]*?)<\/ultrawork-mode>\s*<\/omp-ulw-policy>/.exec(text)?.[1];
        assert(policy && policy.trim().length > 200, "Activated ULW policy must contain the workflow directive");
        assert(!nativeBase.join("\n\n").includes(policy), "Workflow policy must come from the candidate hook");
      }
      assert.deepEqual(errors, [], "Managed ULW native hooks failed");
      assert.equal(networkAttempts, 0);
    };
    const compose = async (prompt: string, base: string[], workflow: boolean) => {
      currentSystemPrompt = [...base];
      const result = await runner.emitBeforeAgentStart(prompt, undefined, [...base]);
      const blocks = result?.systemPrompt ?? base;
      currentSystemPrompt = blocks;
      check(blocks, workflow);
      return blocks;
    };
    // Fresh turns and recomposition must both retain exactly one preset. No
    // input event, command handler, session.prompt(), provider, or goal executes.
    const ordinary = "Inspect the requested implementation and report evidence.";
    for (let turn = 0; turn < 2; turn++) {
      await compose(ordinary, await compose(ordinary, nativeBase, false), false);
    }
    assert.deepEqual(sessionManager.getBranch(), initialBranch, "Ordinary profile loading must not arm workflow state");
    const activated = `ulw ${ordinary}`;
    for (let turn = 0; turn < 2; turn++) {
      await compose(activated, await compose(activated, nativeBase, true), true);
    }
    assert(sessionManager.getBranch().every(entry => entry.type !== "message"),
      "Workflow activation inspection must not create user/model messages");
    console.log(JSON.stringify({ extensions: loaded.extensions.length,
      compatibility: "native-prompt-composition", model: `${model.provider}/${model.id}`,
      ordinaryTurns: 2, activatedTurns: 2, sessionPersistence: "memory", networkAttempts }));
  } finally {
    try {
      await runner.emit({ type: "session_shutdown" });
      assert.deepEqual(errors, [], "Managed ULW native hooks failed");
      assert.equal(networkAttempts, 0);
    } finally {
      runner.clearManagedTimers();
      runner.disposeFileFallbacks();
    }
  }
} finally { authStorage.close(); }
process.exit(0);
