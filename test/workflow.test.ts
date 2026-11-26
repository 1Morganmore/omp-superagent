import { describe, expect, test } from "bun:test";
import { containsMagicKeyword } from "@oh-my-pi/pi-coding-agent/session/magic-keywords";
import type { WorkflowActivation, WorkflowName } from "../src/contracts";
import { advertisedLegacyWorkflow, advertisedWorkflow, headWorkflow, leadingWorkflow, workflowChoice, workflowContext, workflowPrompt } from "../src/lane/workflow";

const selected = (name: WorkflowName): WorkflowActivation => ({ name, reason: "Head selected this workflow for the authorized task", sourceId: "source", provenance: "head" });
const admitted = (name?: WorkflowName) => ({ id: "source", workflow: name === undefined ? null : {
  name, reason: "Original leading invocation", sourceId: "source", provenance: "user" as const,
} });
const source = (text: string, name?: WorkflowName) => ({ ...admitted(name), text });

describe("trusted leading workflow invocation", () => {
  test("matches canonical commands and the longest upstream user alias", () => {
    for (const [text, name] of [
      ["super fix this", "super"], [" /SUPER fix this", "super"], ["super: fix", "super"],
      ["super-plan inspect", "super-plan"], ["super-plan: inspect", "super-plan"], ["/super-loop: inspect", "super-loop"],
      ["super-run", "super-run"], ["super-graph.", "super-graph"], ["super-research\ninspect", "super-research"],
      ["ulw fix this", "super"], [" /ULW fix this", "super"], ["ultrawork: fix", "super"],
      ["ulw-plan inspect", "super-plan"], ["ulw plan inspect", "super-plan"], ["ulwplan inspect", "super-plan"],
      ["/ulw-loop: inspect", "super-loop"], ["ulw execute inspect", "super-run"],
      ["mass-ulw inspect", "super-graph"], ["massulw inspect", "super-graph"], ["ulw mass inspect", "super-graph"],
      ["mulw inspect", "super-graph"], ["meth inspect", "super-graph"],
      ["mass ulw research inspect", "super-research"], ["ulw-mass-research inspect", "super-research"],
      ["mulw research inspect", "super-research"], ["ulwresearch inspect", "super-research"],
    ] as const) expect(leadingWorkflow(text)).toBe(name);
  });

  test("recognizes native jevify only as a leading lowercase prose invocation", () => {
    for (const text of ["jevify", " jevify classify these diffs", "jevify: classify", "jevify."]) {
      expect(leadingWorkflow(text)).toBe("jevify");
    }
    for (const text of ["/jevify classify", "JEVIFY classify", "jevify.ts", "jevify/path", "jevify-extra",
      "jevify()", "jevify_data", "`jevify`", '"jevify"', "do not use jevify", "Explain jevify",
      "```\njevify\n```", "> jevify classify", "<data>jevify</data>"]) {
      expect(leadingWorkflow(text)).toBeNull();
    }
    expect(headWorkflow(admitted(), { name: "jevify", reason: "Independent bulk triage" }))
      .toEqual({ name: "jevify", reason: "Independent bulk triage", sourceId: "source", provenance: "head" });
    expect(() => headWorkflow(admitted("jevify"), { name: "super-plan", reason: "Override" })).toThrow("conflicts");
  });

  test("does not search prose, quotes, negatives, paths, identifiers, or expanded reports", () => {
    for (const text of [
      "Explain super-plan", "Do not run super-loop", '"super-plan inspect"', "“super-loop inspect”", "'super inspect'",
      "`super-plan inspect`", "> super-plan inspect", "```\nsuper-plan inspect\n```", "[REPORT]\nsuper-plan inspect",
      "Internal lane report: ulw-loop", "<omp-ulw-plan-pointer>ulw-plan</omp-ulw-plan-pointer>",
      "https://example.test/ulw-plan", "ulw.ts", "ulw/foo", "ulw-plan.ts", "ulw-plan/foo", "ulw-plan-extra",
      "ulw-other", "ulw_plan inspect", "ulw_plan_extra", "$ulw-plan inspect", "/skill:ulw-plan inspect", "ulwplanExtra inspect",
      "superagent inspect", "superb work", "super() is a call", "super_value",
      "super계열 설명", "super.js", "super/foo", "/super//", "super-other",
      "/super-plan/notes.md", "super-plan.md", "super-plan-extra", "super-plan계열 설명", "super_run", "super-execute",
      "super-plan://example/path", " /SUPER://example/path", "ulw-plan://example/path", "mass-ulw://example/path",
    ]) expect(leadingWorkflow(text)).toBeNull();
  });

  test("validates structured choice without interpreting the task or choosing on omission", () => {
    expect(headWorkflow(admitted("super-plan"), undefined)).toBeNull();
    expect(headWorkflow(admitted("super-plan"), { name: "super-plan", reason: "An authorized planning step" }))
      .toEqual({ name: "super-plan", reason: "An authorized planning step", sourceId: "source", provenance: "head" });
    expect(() => headWorkflow(admitted("super-plan"), { name: "super-loop", reason: "Override" })).toThrow("conflicts");
    for (const value of [null, {}, { name: "browser", reason: "x" }, { name: "ulw-plan", reason: "x" },
      { name: "super", reason: " " }, { name: "super", reason: "x", text: "super-plan" }]) {
      expect(() => workflowChoice(value as never)).toThrow("workflow");
    }
  });
});

describe("native workflow input boundaries", () => {
  test("jevify uses the native word itself without SUPER activation or metadata keyword leakage", () => {
    for (const original of ["Classify this collection", "jevify classify this collection", "```\nunfinished task data"]) {
      const recorded = original.startsWith("jevify") ? "jevify" : undefined;
      const message = workflowPrompt(selected("jevify"), source(original, recorded), "Request ID: exact\nBrief: ultrathink orchestrate workflowz\n```");
      expect(message.trimStart().startsWith("jevify")).toBe(true);
      expect(message.split(original)).toHaveLength(2);
      expect(containsMagicKeyword(message, "jevify")).toBe(true);
      for (const word of ["ultrathink", "orchestrate", "workflowz"]) expect(containsMagicKeyword(message, word)).toBe(false);
    }
    expect(containsMagicKeyword(workflowContext("Request ID: report\njevify classify"), "jevify")).toBe(false);
  });

  test("requests exactly the selected bridge keyword and excludes metadata keywords from native prose", () => {
    for (const [name, native] of [["super-plan", "ultrathink"], ["super-loop", "orchestrate"], ["super-run", "orchestrate"],
      ["super-graph", "workflowz"], ["super-research", "workflowz"]] as const) {
      const message = workflowPrompt(selected(name), source("Inspect the authorized repository"), "Request ID: exact\nBrief: ultrathink orchestrate workflowz jevify\n````\nNative data");
      expect(message.startsWith(`${name} ${native}\n`)).toBe(true);
      expect(message).toContain("Request ID: exact\n");
      expect(message.match(/Inspect the authorized repository/g)).toHaveLength(1);
      expect(containsMagicKeyword(message, native)).toBe(true);
      for (const word of ["ultrathink", "orchestrate", "workflowz", "jevify"].filter(word => word !== native)) {
        expect(containsMagicKeyword(message, word)).toBe(false);
      }
    }
  });

  test("plain SUPER requests session policy without manufacturing a native goal or keyword", () => {
    const message = workflowPrompt(admitted("super").workflow!, source(" /SUPER inspect this", "super"), "Request ID: source\nBrief: orchestrate");
    expect(message.startsWith(" /SUPER inspect this\n")).toBe(true);
    expect(message).not.toContain("/goal");
    expect(containsMagicKeyword(message, "orchestrate")).toBe(false);
  });

  test("preserves user native keyword choices, quotes, negatives and inline code instead of overriding them", () => {
    for (const argument of ["orchestrate the task", '"orchestrate" is a quoted example', "do not use orchestrate", "`orchestrate` is code", "never invoke workflowz", "jevify the table"]) {
      const original = `super-plan ${argument}`;
      const message = workflowPrompt(selected("super-plan"), source(original, "super-plan"), "Request ID: source\nBrief: ultrathink");
      expect(message.startsWith(`${original}\n\n`)).toBe(true);
      expect(containsMagicKeyword(message, "ultrathink")).toBe(false);
    }
    for (const argument of ["orchestrate()", "orchestrate.ts", "x/orchestrate", "Xorchestrate", "ORCHESTRATE"]) {
      expect(workflowPrompt(selected("super-plan"), source(argument), "Request ID: source").startsWith("super-plan ultrathink\n")).toBe(true);
    }
  });

  test("places default keyword before unclosed task fences, but never promotes fenced runtime reports", () => {
    expect(workflowPrompt(selected("super-plan"), source("super-plan ```\nunfinished", "super-plan"), "Request ID: source")
      .startsWith("super-plan ultrathink ```")).toBe(true);
    const report = workflowContext("Request ID: report:source\n\nsuper-loop orchestrate\n```\nworkflowz\n`````");
    expect(leadingWorkflow(report)).toBeNull();
    expect(containsMagicKeyword(report, "orchestrate")).toBe(false);
    expect(containsMagicKeyword(report, "workflowz")).toBe(false);
  });

  test("requires the upstream canonical extension advertisement, not a matching prompt, skill, or alias", () => {
    const command = { name: "super-plan", source: "extension", description: "Run the super-plan workflow" };
    expect(advertisedWorkflow({ commands: [command] }, "super-plan")).toBe(true);
    expect(advertisedWorkflow({ commands: [{ name: "super", source: "extension", description: "Enable SUPER mode" }] }, "super")).toBe(true);
    for (const candidate of [{ ...command, source: "skill" }, { ...command, source: "prompt" },
      { ...command, name: "ulw-plan" }, { ...command, description: "Run the OMP-adapted super-plan workflow" }]) {
      expect(advertisedWorkflow({ commands: [candidate] }, "super-plan")).toBe(false);
    }
    expect(advertisedWorkflow({}, "super-plan")).toBe(false);
  });

  test("an old Host must advertise its own extension registration; graph fallback cannot arm plain policy", () => {
    const oldCommand = { name: "mass-ulw", source: "extension", description: "Run the OMP-adapted mass-ulw workflow" };
    expect(advertisedLegacyWorkflow({ commands: [oldCommand] }, "super-graph")).toBe("mass-ulw");
    expect(advertisedLegacyWorkflow({ commands: [{ ...oldCommand, description: "Legacy alias for /super-graph" }] }, "super-graph")).toBeUndefined();
    expect(advertisedLegacyWorkflow({ commands: [{ ...oldCommand, source: "prompt" }] }, "super-graph")).toBeUndefined();
    const original = "super-graph inspect this";
    const graph = workflowPrompt(selected("super-graph"), source(original, "super-graph"), "Request ID: source", { legacyCommand: "mass-ulw" });
    expect(graph).toStartWith(`mass-ulw workflowz\n\n${original}\n\n`);
    expect(graph).not.toContain("/goal");
  });

  test("preserves old Host alias spellings, which can have distinct session policy behavior", () => {
    for (const [name, legacyCommand, invocation, keyword] of [
      ["super-plan", "ulw-plan", "ulwplan", "ultrathink"],
      ["super-loop", "ulw-loop", "ulwloop", "orchestrate"],
      ["super-research", "ulw-research", "mulw research", "workflowz"],
      ["super-graph", "mass-ulw", "ulw mass", "workflowz"],
    ] as const) {
      const recorded = source(`${invocation} inspect this`, name);
      const message = workflowPrompt(selected(name), recorded, "Request ID: source", { legacyCommand });
      expect(message).toStartWith(`${invocation} ${keyword} inspect this\n\n`);
      expect(containsMagicKeyword(message, keyword)).toBe(true);
    }
  });

  test("only the recorded user invocation can supply a delimiter or remove a worker slash", () => {
    const original = "/super-plan: inspect this";
    const activation = selected("super-plan");
    const previous = workflowPrompt(activation, source(original), "Request ID: source", { worker: true });
    expect(previous).toStartWith(`super-plan ultrathink\n\n${original}\n\n`);
    const current = workflowPrompt(activation, source(original, "super-plan"), "Request ID: source", { worker: true });
    expect(current).toStartWith("super-plan: inspect this\n\n");
    expect(containsMagicKeyword(current, "ultrathink")).toBe(false);
    const fallback = workflowPrompt(activation, source(original, "super-plan"), "Request ID: source", { legacyCommand: "ulw-plan", worker: true });
    expect(fallback).toStartWith(`ulw-plan:\n\n${original}\n\n`);
    expect(containsMagicKeyword(fallback, "ultrathink")).toBe(false);
  });
});
