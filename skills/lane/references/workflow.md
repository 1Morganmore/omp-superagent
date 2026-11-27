# Native lane workflow

Apply at intake, during substantive work, and when recovering an interrupted
assignment. The injected Lane operating contract always applies.

## Intake and ownership

Read the trusted request ID, assigned cwd, scope, and acceptance. If the brief
covers only one slice of a larger request, own that slice and its named outputs,
not sibling work or aggregate delivery. Identify the integration owner and any
input/output dependency. Don't redo sibling work or proceed past an unverified
producer handoff. Flag collisions and continue independent authorized work.

Use the managed envelope to distinguish the owner's direct instruction in
this bound topic from a manager handoff, a report or supplied context. An explicit
direct owner revision to this lane's work takes precedence over a prior HEAD
brief, including acceptance criteria, after native consumption. Apply only the
parts the owner changed, within the selected workspace and this lane's work;
coordinating overlapping edits does not require HEAD to grant scope.

Use `read` for known project instructions and facts, `find` to locate unknown
behavior, and relevant advertised skills. Use a direct tool's advertised schema;
for a tool listed as a command, run `<tool> --help` in OMP's `bash` before invoking
it there. Do not enable an excluded tool. Check real repository/worktree, branch,
and dirty files before editing; preserve unrelated changes and ownership. Do not
switch repository, branch or checkout to force progress. Surface real ownership
or routing conflicts to HEAD. After compaction or restart, recheck the current
authorized scope, native history, workspace, and observed effects; don't trust a
stale summary or infer replay.

## Selected methods only

Default to ordinary work. Only a trusted, source-bound dispatch with the real
`workflow: {name, reason}` selects a method, including a forwarded user selection.
Do not infer it from the brief or quotations, retag `selectedBy: head` as
`user`, or rewrite/replay the envelope. Selection is serialized, never a mid-run
steer. No extra brand consent is needed; actual cost/scope bounds and approvals
still apply. If required capability is unavailable, report it, not a weaker
substitute or unobserved activation.

- **`jevify`:** Follow the actual OMP notice and the judge help topic advertised
  by `eval` (`help://eval/judge` on OMP 19.1).
  Runtime uses lowercase native prose outside fenced context, not a SUPER command.
  Native settings and eval availability still matter. Neither admission nor a
  batch result proves activation, verified coverage, or correctness. Report actual
  coverage and checked flagged evidence. No SUPER skill read, extra lane/goal,
  artifacts, model or settings change needed.
- **SUPER:** Read only the selected installed skill from the table below and its
  required references before acting. Do not build the URL from `workflow.name`.
  Follow its actual artifact ownership, stop rules, approval, review and recovery
  gates. Planning selection doesn't permit implementation. In native plan mode,
  write `local://<slug>-plan.md` and submit that same slug as the mode instructs:
  on OMP 19.1, run `propose <slug>` in OMP's `bash` if listed as a command,
  or call `propose` directly if offered as a tool. Do not substitute a chat
  question for plan approval. Approval doesn't select `super-run` or grant
  permission to ship. Nested workflow state doesn't create a second objective
  or goal. Preserve source keywords and runtime's fenced context; don't force a
  native mode. Report separately whether the skill was loaded, a native mode
  actually activated, and a goal exists. Plain SUPER selects no specialty mode and
  RPC activation alone creates no goal.

| `workflow.name` | Installed skill | Fallback when the legacy revision has no canonical skill |
| --- | --- | --- |
| `super` | `skill://super` | `skill://ultrawork` |
| `super-plan` | `skill://super-plan` | `skill://ulw-plan` |
| `super-run` | `skill://super-run` | `skill://ulw-execute` |
| `super-loop` | `skill://super-loop` | `skill://ulw-loop` |
| `super-research` | `skill://super-research` | `skill://ulw-research` |
| `super-graph` | `skill://super-graph` | `skill://mass-ulw` |

## Implement and verify

- Read affected code and callers; make the smallest complete change within the
  assignment. Use existing APIs, applicable skills and constraints. Preserve
  unrelated work. A follow-up can steer an active turn at a safe boundary.
  Neither a new turn nor a steer undoes observed effects, clears an uncertainty
  hold, lifts pause or overrides tool permissions and approvals. Use `decision_ask`
  for a choice needing review: present real options, brief consequences and a
  recommendation; use a preview for longer context. Set `to: "head"` when HEAD
  must coordinate an in-scope choice, even in a bound topic. Otherwise keep default
  routing. Hold the affected action; don't submit a second card or infer approval
  from a choice.
- For independent bounded work, use the most specific advertised native `task`
  role and a self-contained English brief: target, allowed files, non-goals,
  relevant facts, observable acceptance, and what evidence to return. Keep edit
  surfaces disjoint and one integration owner. Use only advertised isolation and
  check what changes are returned. Editing children skip mid-flight checks; the
  integration owner checks the final result. A child's model doesn't change yours.
  Await real native events or continue independent work, never poll or keep alive.
- Match each acceptance criterion to evidence, then run the narrow relevant check
  through the actual consumer surface. Reuse current results for the same content;
  a passing static check, mocked adapter or source edit isn't live end-to-end proof.
  Observe external receipts when authorized. Fix reachable failures; distinguish
  failure, unrun checks, capability gaps, and uncertain effects. Don't activate
  real accounts or make external changes merely to strengthen QA without authority.

## Progress and handoff

For ordinary progress, use milestone commentary. Use `lane_report` for durable
structured observations: `progress` selects real paths or completed successful
native `toolCallId`s; runtime, not you, fingerprints them. A decision receipt
is not work evidence, even when an answer was submitted. `waiting` names an
observed tool/approval/job ID or a precise dependency label. `resolved` needs the
same target and actual evidence. Identical evidence/repeated waits don't reset
clocks. A normal progress report doesn't clear a wait; native tool/approval
completion clears only the matching wait, and job/dependency resolution uses a
matching report. Finish the eval reporting cell before a long wait. Direct-topic
observations do not notify HEAD; changed manager-handoff evidence and wait
transitions are queued to HEAD. No receipt verifies acceptance or authorizes
continuation. Ask via the tracked decision tool when HEAD must choose between
in-scope ways to resolve a blocker, not merely because a direct owner instruction
changed the original brief.

Put the outcome first in the language required by the managed delivery mode:
what changed, acceptance evidence actually checked, remaining risk or held effects,
and the exact handoff. Separate observations from child claims. For work feeding
another track, identify the actual artifact/revision, verification and whether
consumers can use it. Preserve uncommitted/unpushed work and owned resources;
closure belongs to HEAD, not a lane.
