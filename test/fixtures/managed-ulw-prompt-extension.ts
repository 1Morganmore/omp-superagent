import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// The updater tests materialize this independent, minimally compatible native
// extension into a local git remote. Defects exercise executable hook results.
const defect: string = "none";
const preset = `<omp-model-preset>
You are a coding agent on Grok 4.5. Inspect the available evidence before deciding
what to change. Delegate independent work only when the active tools permit it.
Keep host permissions and the assigned scope authoritative. Report observed
results precisely, and distinguish unrun checks from verified behavior.
</omp-model-preset>`;
const policy = `<omp-ulw-policy>
<ultrawork-mode>
Carry the explicitly requested objective through the authorized work. Establish
concrete completion criteria, inspect the implementation, and resolve dependent
steps in order. Preserve approval boundaries and cancellation. Finish with
evidence for completed criteria and an honest account of blocked requirements.
</ultrawork-mode>
</omp-ulw-policy>`;

export default function compatiblePromptFixture(pi: ExtensionAPI): void {
  let active = false;
  pi.on("before_agent_start", event => {
    if (defect === "no-effect") return;
    const [native, ...tail] = event.systemPrompt;
    if (!native) return;
    const replacement = defect === "empty-preset" ? "<omp-model-preset></omp-model-preset>" : preset;
    const base = native.includes("<omp-model-preset>") ? native : native.replace(
      /(^|\n[§⁂] Role\n)[\s\S]*?(?=\n[§⁂] Runtime\n)/,
      (_role, heading: string) => `${heading}${replacement}\n`,
    );
    if (/^ulw\s/.test(event.prompt)) active = true;
    const blocks = [base, ...tail.filter(block => !block.startsWith("<omp-ulw-policy>")
      && !(defect === "duplicate-preset" && block === preset))];
    if (defect === "duplicate-preset") blocks.push(preset);
    if (active && defect !== "missing-workflow") {
      blocks.push(policy);
      if (defect === "duplicate-workflow") blocks.push(policy);
    }
    return { systemPrompt: blocks };
  });
}
