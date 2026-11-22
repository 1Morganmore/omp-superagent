import { WORKFLOW_NAMES, type InputRecord, type WorkflowActivation, type WorkflowChoice, type WorkflowName } from "./contracts";

// Public commands and leading delimiters match omp-superkit ulw.ts at c11a6e4.
// Skill paths and persisted native keys are deliberately not public selectors.
const legacyCommands = {
  super: "ulw", "super-plan": "ulw-plan", "super-loop": "ulw-loop", "super-run": "ulw-execute",
  "super-graph": "mass-ulw", "super-research": "ulw-research",
} as const satisfies Record<Exclude<WorkflowName, "jevify">, string>;
type LegacyWorkflowName = typeof legacyCommands[keyof typeof legacyCommands];
const canonical = new RegExp(String.raw`^(${Object.keys(legacyCommands).join("|")})\b(?![-_.]?[A-Za-z0-9])(?=[\s:.,!?]|$)`, "i");
const aliases: Array<[WorkflowName, RegExp]> = [
  ["super-research", /^(?:ulw|mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)[\s-]*research\b/i],
  ["super-graph", /^(?:mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)\b/i],
  ["super-plan", /^ulw[\s-]*plan\b/i],
  ["super-loop", /^ulw[\s-]*loop\b/i],
  ["super-run", /^ulw[\s-]*execute\b/i],
];
const identifierTail = /^(?:[-_][A-Za-z0-9]|\.[A-Za-z0-9]|[-_.]?[A-Za-z0-9]*[/\\])/;
const leadingUri = /^\s*\/?[a-z][a-z0-9+.-]*:\/\//i;
const nativeWords = /(?<![\p{L}\p{N}_./\\-])(?<!::)(?:ultrathink|orchestrate|workflowz|jevify)(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()/u;
const nativeWord: Partial<Record<WorkflowName, string>> = {
  "super-plan": "ultrathink", "super-loop": "orchestrate", "super-run": "orchestrate",
  "super-graph": "workflowz", "super-research": "workflowz",
};

/** Parse the spelling of an invocation; only admission may choose it. */
function invocation(text: string): { name: WorkflowName; length: number; legacy?: true } | null {
  // Unlike SUPER commands, native jevify is lowercase prose, never a slash command.
  const native = /^\s*jevify(?=$|[\s:.,!?])/.exec(text);
  if (native && !identifierTail.test(text.slice(native[0].length))) return { name: "jevify", length: native[0].length };
  const prefix = /^\s*\/?/.exec(text)![0].length;
  const leading = text.slice(prefix);
  const primary = canonical.exec(leading);
  if (primary) return { name: primary[0].toLowerCase() as WorkflowName, length: prefix + primary[0].length };
  for (const [name, expression] of aliases) {
    const match = expression.exec(leading);
    if (match && /^(?:[\s:.,!?]|$)/.test(leading.slice(match[0].length))
      && !identifierTail.test(leading.slice(match[0].length))) return { name, length: prefix + match[0].length, legacy: true };
  }
  const plain = /^(?:ultrawork|ulw)\b/i.exec(leading);
  if (!plain) return null;
  const tail = leading.slice(plain[0].length);
  if (/^[-_.]?[A-Za-z0-9]*[/\\]/.test(tail)) return null;
  // Native ULW permits a suffix only for its named workflow family; unsupported
  // identifiers and paths are data. Do not search past quotes or negations.
  if (identifierTail.test(tail) && !/^[-_](?:loop|plan|research|execute|mass)(?![-_.]?[A-Za-z0-9])/i.test(tail)) return null;
  return { name: "super", length: prefix + plain[0].length, legacy: true };
}

export function leadingWorkflow(text: string): WorkflowName | null {
  const match = invocation(text);
  // Upstream masks URLs before reading its SUPER/ULW selectors. Do not
  // accidentally admit one just because a real command may use a colon.
  return match && (match.name === "jevify" || !leadingUri.test(text)) ? match.name : null;
}

/** Read old coordination identities without making aliases valid manager inputs. */
export function storedWorkflowName(name: string): WorkflowName {
  for (const canonical of WORKFLOW_NAMES) {
    if (canonical === name || canonical !== "jevify" && legacyCommands[canonical] === name) return canonical;
  }
  throw new Error("Unknown stored workflow identity");
}

export function workflowChoice(value: WorkflowChoice | undefined): WorkflowChoice | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || !WORKFLOW_NAMES.includes(value.name)
    || typeof value.reason !== "string" || !value.reason.trim()
    || Object.keys(value).some(key => key !== "name" && key !== "reason")) {
    throw new Error("workflow requires a supported name and a nonempty reason");
  }
  return { name: value.name, reason: value.reason };
}

type WorkflowSource = Pick<InputRecord, "id" | "workflow">;

function admittedUserWorkflow(source: WorkflowSource): WorkflowName | null {
  const workflow = source.workflow;
  return workflow?.provenance === "user" && workflow.sourceId === source.id ? workflow.name : null;
}

/** Head selection is typed authority; use the original admission, not today's parser. */
export function headWorkflow(source: WorkflowSource, choice: WorkflowChoice | undefined): WorkflowActivation | null {
  const selected = workflowChoice(choice);
  if (!selected) return null;
  const user = admittedUserWorkflow(source);
  if (user && user !== selected.name)
    throw new Error("Head workflow conflicts with the original user's workflow invocation");
  return { ...selected, sourceId: source.id, provenance: "head" };
}

/** Native matchers must not treat routing/brief/report prose as user keywords. */
export function workflowContext(envelope: string): string {
  let longest = 2;
  for (const match of envelope.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}superagent-runtime-context\n${envelope}\n${fence}`;
}

/** Keep user native keywords (including quoted/negative ones) byte-for-byte. */
export function workflowPrompt(activation: WorkflowActivation, source: WorkflowSource & { text: string }, envelope: string,
  { legacyCommand, worker = false }: { legacyCommand?: LegacyWorkflowName; worker?: boolean } = {}): string {
  // A pending handoff can predate the current vocabulary. An ordinary task
  // heading is not a user's selector or a reason to suppress a native default.
  const leading = admittedUserWorkflow(source) === activation.name ? invocation(source.text) : null;
  const selected = leading?.name === activation.name ? leading : null;
  const invocationText = selected ? source.text.slice(0, selected.length) : "";
  const argumentsText = source.text.slice(invocationText.length);
  const explicitDelimiter = selected ? /^\S/.exec(argumentsText)?.[0] ?? "" : "";
  const keyword = nativeWord[activation.name];
  // Apply only the native bridge's default. A raw user mention, even quoted or
  // negated, suppresses that default and is left for OMP's native prose matcher.
  // Check before adding context, whose metadata must not change this decision.
  const nativeDefault = keyword && !explicitDelimiter && !nativeWords.test(argumentsText) ? ` ${keyword}` : "";
  // A resident old Host still understands the original ULW user aliases. Keep
  // their spelling, because e.g. "ulwplan" does not arm the same session policy
  // as "ulw-plan". Only synthesized selectors use the old registration name.
  const keepInvocation = selected && (!legacyCommand || selected.legacy);
  // A worker takes ordinary prose, not native slash-command dispatch.
  const prefix = worker ? invocationText.replace(/^(\s*)\//, "$1") : invocationText;
  const request = keepInvocation
    ? `${prefix}${nativeDefault}${argumentsText}`
    : `${legacyCommand ?? activation.name}${explicitDelimiter}${nativeDefault}\n\n${source.text}`;
  return `${request}\n\n${workflowContext(envelope)}`;
}

function advertisedCommand(value: unknown, name: string, description: string): boolean {
  if (!value || typeof value !== "object" || !("commands" in value) || !Array.isArray(value.commands)) return false;
  return value.commands.some(command => command && typeof command === "object"
    && command.name === name && command.source === "extension"
    && command.description === description);
}

export function advertisedWorkflow(value: unknown, name: WorkflowName): boolean {
  return name !== "jevify" && advertisedCommand(value, name, name === "super" ? "Enable SUPER mode" : `Run the ${name} workflow`);
}

/** Pre-rename extension registrations, not the new extension's legacy aliases. */
export function advertisedLegacyWorkflow(value: unknown, name: WorkflowName): LegacyWorkflowName | undefined {
  if (name === "jevify") return undefined;
  const legacy = legacyCommands[name];
  return advertisedCommand(value, legacy, `Run the OMP-adapted ${legacy} workflow`) ? legacy : undefined;
}
