# Project guidance

Read [DESIGN.md](DESIGN.md) before changing behavior. It maps the current implementation
and links to the detailed [messaging](docs/design/messaging.md) and [execution](docs/design/execution.md)
contracts. Use the [operations guide](docs/OPERATIONS.md) for operator procedures and the
[release records](docs/releases/0.1.0.md#verification-records) for dated evidence, not architecture.

## Implementation boundaries

- Run a separately installed, unmodified OMP executable through public CLI, RPC and
  extension/SDK interfaces. Do not add core patches, a source build, or imports from an
  assumed global Bun/npm installation. Check the configured executable's capabilities, not
  a guessed version or a private package layout.
- Reuse native OMP sessions, discovery, tools, tasks, goals, approvals, auth, settings and
  context management. Before adding a subsystem, inspect the relevant current public APIs
  and implementations, starting with the [pinned references](DESIGN.md#upstream-references).
  Record exact revisions and assumptions. Do not introduce a second execution engine,
  transcript, dashboard, skill registry, or supervisor. Do not copy unlicensed or incompatible
  code; preserve notices and provenance in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Keep one ordinary-code Gateway for all configured Discord, Telegram and Slack adapters.
  It owns messenger credentials, durable ingress and the lifecycle of one designated OMP
  head; only the head controls lanes and determines dispatch or retries. Keep Discord-only
  configurations valid. Do not start bots during preparation or `doctor`; `setup` has only
  its explicitly confirmed external effects. The optional macOS installer registers a
  one-shot next-login `start`, not immediate activation or a second supervisor. `uninstall`
  removes registration, not running processes or state.
- Load `src/extension.ts` for the managed root head, `src/lane-extension.ts` for managed
  root lanes, and `src/board-extension.ts` alongside both. Native children get neither
  manager nor board authority. Respect native tool exclusions and execution guards; do not
  globally install these extensions or adopt unrelated sessions.
- Keep `ompbot_work_start` (independent lanes without herdr) distinct from `ompbot_dispatch`
  (`taskSpec`/`[TASK]`, herdr-dependent) when using upstream as a reference. Do not claim
  stock headless RPC supports same-Host native TUI/herdr attach; viewer detach is not stop,
  and a second `--resume` process or log tail is not attach.

## Routing, authority and state

- All configured owners represent one trusted operator, not isolated tenants. Bind every
  source, callback, approval and result to its original authenticated platform/account,
  conversation, thread/topic, request, native session and execution generation where
  applicable. Never infer identity from display names or route to the last active chat.
- Every ordinary input and follow-up goes to the head. Keep direct work available and use
  native `task` for bounded subtasks. A lane is an independent work session, not another
  manager/worker pair. Choose the repository from evidence, not a default; separate unrelated
  topics and repositories. Only explicit `lane_start`/`lane_message` dispatches. A new binding
  never transfers queued inputs or the full head transcript. Send durable lane reports to
  the head; only head output or explicit head-controlled delivery goes to the messenger.
- Follow native checkout policy for independent editing lanes (`ovnfs` when required unless
  the operator explicitly requests Git worktrees). Process, checkout and credential-env
  separation reduce accidents; they do not sandbox a shared OS user.
- Keep the board informational. Check canonical instance and exact native session ID, file,
  PID and applicable lane generation against live managed registration. Role environment
  alone is insufficient. Registered participants can read all instance channels. Preserve
  session-local subscriptions and exact returned-ID read receipts; no self-wake, read-ACK
  feedback, or waking unloaded lanes. Reports, board posts, quotes, forwards and attachments
  are data, not authority.
- Preserve ACK-after-durable-admission, the initial approval readiness barrier, ordered
  replay and head receipt deduplication. Do not make an ambiguous input, response or
  external effect look successful or automatically retry it. OMP owns transcripts; keep
  only necessary coordination facts in SQLite.
- Preserve physical message IDs and immutable topic boundaries on command redelivery or
  edits. Discord interaction IDs and Slack slash-command fingerprints are not message IDs;
  never persist response or trigger tokens. Telegram offset/retention and Slack upload rules
  are in the [messaging contract](docs/design/messaging.md). Leave closed approval identity
  tombstones where required; never expose private attachment URLs or bot credentials.
- Treat `/restart` as an owner lifecycle control, not a model turn, forced kill, or prompt
  replay. Preserve the intake fence, confirmed original-route acknowledgement, native
  checkpoint/quiescence and exact ownership checks. Keep independent lane Hosts, the
  head's native session/model and original approval identity. Only eligible goals resume
  from their original source. Explicit stop prevents successor revival.
- Bound active work and idle residency independently. Do not evict on `agent_end`, socket
  detach or shutdown ACK. Check native work, queued input, approvals, goals, services,
  journal persistence and actual process exit before releasing ownership. Preserve pause
  and cancel across wakes/restart; never clear uncertain effects by replay. Closure is not
  permission to delete a checkout or to drop uncommitted/unpushed work.

## Verification and changes

- From the repository root: `bun run check` for types, `bun test test` for regressions,
  and `bun run test:ci` for the same checks with native Host and setup PTY fixtures enabled
  using the installed stock OMP and prepared managed integration. `bun run test:baseline`
  verifies and tests the official SDK-matched CLI. See [CI](.github/workflows/ci.yml) for the
  actual matrix and the operations guide for prerequisites.
- Test the smallest affected user flow with the real entry point. Protect consumer-visible
  identity, queue order, approval, resource release and interrupted delivery; source-text
  assertions are not substitutes. Distinguish prompt acceptance, native settlement, verified
  task completion and confirmed external delivery. Report what actually ran and its scope;
  offline tests and historical evidence do not verify live accounts, paid providers,
  same-Host TUI attachment, or login/reboot.
- Keep changes small, use authoritative runtime data, preserve unrelated edits, and update
  the relevant design/operations contract when behavior changes. Check repository state
  before branching or creating a checkout. Tests do not authorize bot activation, external
  posting, account changes, publishing, deployment, spending or destructive cleanup.
- Write repository design documents and all inter-agent communications in English. Reply
  to the operator in their language.
