import { describe, expect, test } from "bun:test";
import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import type { WorkflowActivation, WorkflowName } from "../src/contracts";
import { advertisedWorkflow, headWorkflow, leadingWorkflow, workflowChoice, workflowContext, workflowPrompt } from "../src/workflow";

const selected = (name: WorkflowName): WorkflowActivation => ({ name, reason: "Head selected this workflow for the authorized task", sourceId: "source", provenance: "head" });

describe("trusted leading workflow invocation", () => {
  test("matches the actual ULW family aliases and longest research invocation", () => {
    for (const [text, name] of [
      ["ulw fix this", "ulw"], [" /ULW fix this", "ulw"], ["ultrawork: fix", "ulw"],
      ["ulw-plan inspect", "ulw-plan"], ["ulw plan inspect", "ulw-plan"], ["ulwplan inspect", "ulw-plan"],
      ["/ulw-loop: inspect", "ulw-loop"], ["ulw execute inspect", "ulw-execute"],
      ["mass-ulw inspect", "mass-ulw"], ["massulw inspect", "mass-ulw"], ["ulw mass inspect", "mass-ulw"],
      ["mulw inspect", "mass-ulw"], ["meth inspect", "mass-ulw"],
      ["mass ulw research inspect", "ulw-research"], ["ulw-mass-research inspect", "ulw-research"],
      ["mulw research inspect", "ulw-research"], ["ulwresearch inspect", "ulw-research"],
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
    expect(headWorkflow("source", "Classify the diffs", { name: "jevify", reason: "Independent bulk triage" }))
      .toEqual({ name: "jevify", reason: "Independent bulk triage", sourceId: "source", provenance: "head" });
    expect(() => headWorkflow("source", "jevify classify", { name: "ulw-plan", reason: "Override" })).toThrow("conflicts");
  });

  test("does not search prose, quotes, negatives, paths, identifiers, or expanded reports", () => {
    for (const text of [
      "Explain ulw-plan", "Do not run ulw-loop", '"ulw-plan inspect"', "“ulw-loop inspect”", "'ulw inspect'",
      "`ulw-plan inspect`", "> ulw-plan inspect", "```\nulw-plan inspect\n```", "[REPORT]\nulw-plan inspect",
      "Internal lane report: ulw-loop", "<omp-ulw-plan-pointer>ulw-plan</omp-ulw-plan-pointer>",
      "https://example.test/ulw-plan", "ulw.ts", "ulw/foo", "ulw-plan.ts", "ulw-plan/foo", "ulw-plan-extra",
      "ulw-other", "ulw_plan inspect", "ulw_plan_extra", "$ulw-plan inspect", "/skill:ulw-plan inspect", "ulwplanExtra inspect",
    ]) expect(leadingWorkflow(text)).toBeNull();
  });

  test("validates structured choice without interpreting the task or choosing on omission", () => {
    expect(headWorkflow("source", "ulw-plan inspect", undefined)).toBeNull();
    expect(headWorkflow("source", "The board mentions ulw-loop", { name: "ulw-plan", reason: "An authorized planning step" }))
      .toEqual({ name: "ulw-plan", reason: "An authorized planning step", sourceId: "source", provenance: "head" });
    expect(() => headWorkflow("source", "ulw-plan inspect", { name: "ulw-loop", reason: "Override" })).toThrow("conflicts");
    for (const value of [null, {}, { name: "browser", reason: "x" }, { name: "ulw", reason: " " }, { name: "ulw", reason: "x", text: "ulw-plan" }]) {
      expect(() => workflowChoice(value as never)).toThrow("workflow");
    }
  });
});

describe("native workflow input boundaries", () => {
  test("jevify uses the native word itself without ULW activation or metadata keyword leakage", () => {
    for (const original of ["Classify this collection", "jevify classify this collection", "```\nunfinished task data"]) {
      const message = workflowPrompt(selected("jevify"), original, "Request ID: exact\nBrief: ultrathink orchestrate workflowz\n```");
      expect(message.trimStart().startsWith("jevify")).toBe(true);
      expect(message.split(original)).toHaveLength(2);
      expect(containsMagicKeyword(message, "jevify")).toBe(true);
      for (const word of ["ultrathink", "orchestrate", "workflowz"]) expect(containsMagicKeyword(message, word)).toBe(false);
    }
    expect(containsMagicKeyword(workflowContext("Request ID: report\njevify classify"), "jevify")).toBe(false);
  });

  test("requests exactly the selected bridge keyword and excludes metadata keywords from native prose", () => {
    for (const [name, native] of [["ulw-plan", "ultrathink"], ["ulw-loop", "orchestrate"], ["ulw-execute", "orchestrate"],
      ["mass-ulw", "workflowz"], ["ulw-research", "workflowz"]] as const) {
      const message = workflowPrompt(selected(name), "Inspect the authorized repository", "Request ID: exact\nBrief: ultrathink orchestrate workflowz jevify\n````\nNative data");
      expect(message.startsWith(`${name} ${native}\n`)).toBe(true);
      expect(message).toContain("Request ID: exact\n");
      expect(message.match(/Inspect the authorized repository/g)).toHaveLength(1);
      expect(containsMagicKeyword(message, native)).toBe(true);
      for (const word of ["ultrathink", "orchestrate", "workflowz", "jevify"].filter(word => word !== native)) {
        expect(containsMagicKeyword(message, word)).toBe(false);
      }
    }
  });

  test("plain ULW only arms its policy and never manufactures a native goal or keyword", () => {
    const message = workflowPrompt({ ...selected("ulw"), provenance: "user" }, " /ULW inspect this", "Request ID: source\nBrief: orchestrate");
    expect(message.startsWith(" /ULW inspect this\n")).toBe(true);
    expect(message).not.toContain("/goal");
    expect(containsMagicKeyword(message, "orchestrate")).toBe(false);
  });

  test("preserves user native keyword choices, quotes, negatives and inline code instead of overriding them", () => {
    for (const argument of ["orchestrate the task", '"orchestrate" is a quoted example', "do not use orchestrate", "`orchestrate` is code", "never invoke workflowz", "jevify the table"]) {
      const original = `ulw-plan ${argument}`;
      const message = workflowPrompt({ ...selected("ulw-plan"), provenance: "user" }, original, "Request ID: source\nBrief: ultrathink");
      expect(message.startsWith(`${original}\n\n`)).toBe(true);
      expect(containsMagicKeyword(message, "ultrathink")).toBe(false);
    }
    for (const argument of ["orchestrate()", "orchestrate.ts", "x/orchestrate", "Xorchestrate", "ORCHESTRATE"]) {
      expect(workflowPrompt(selected("ulw-plan"), argument, "Request ID: source").startsWith("ulw-plan ultrathink\n")).toBe(true);
    }
  });

  test("places default keyword before unclosed task fences, but never promotes fenced runtime reports", () => {
    expect(workflowPrompt(selected("ulw-plan"), "ulw-plan ```\nunfinished", "Request ID: source").startsWith("ulw-plan ultrathink ```")).toBe(true);
    const report = workflowContext("Request ID: report:source\n\nulw-loop orchestrate\n```\nworkflowz\n`````");
    expect(leadingWorkflow(report)).toBeNull();
    expect(containsMagicKeyword(report, "orchestrate")).toBe(false);
    expect(containsMagicKeyword(report, "workflowz")).toBe(false);
  });

  test("requires advertised extension capability, not a same-name prompt or skill", () => {
    const command = { name: "ulw-plan", source: "extension", description: "Run the OMP-adapted ulw-plan workflow" };
    expect(advertisedWorkflow({ commands: [command] }, "ulw-plan")).toBe(true);
    expect(advertisedWorkflow({ commands: [{ ...command, source: "prompt" }] }, "ulw-plan")).toBe(false);
    expect(advertisedWorkflow({ commands: [{ ...command, description: "Other command" }] }, "ulw-plan")).toBe(false);
    expect(advertisedWorkflow({}, "ulw-plan")).toBe(false);
  });
});
