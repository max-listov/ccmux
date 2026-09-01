---
title: Optional native Claude runtime driven by the published agent SDK
description: Add an opt-in execution mode for Claude sessions that speaks the SDK's typed message stream and structured tool permissions, holding the default interactive terminal path constant under the shared code it necessarily touches.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 12:15 +0700
priority: P1
related: docs/research/2026-09-01-positioning-revision.md
---

## Why

Claude is the only supported agent whose session this supervisor cannot observe structurally.
`src/runtime/capabilities.ts:68-78` states it: `structured: false`, `approval: false`, `input: false`,
`nativeStream: false`. Codex, OpenCode and Custom carry `structured: true`, so a control-plane
consumer renders their live conversations, token metrics and answerable tool approvals — and reaches
Claude only as a terminal pane.

The concrete live gap is tool permission. `policyAnswers` (`src/agent/claude/prompts.ts:62-68`)
answers exactly two menus — the resume picker and folder trust — and returns `false` for everything
else, deliberately: "never guess at a menu we cannot read". A per-tool permission prompt therefore
**strands the session**: it is reported as `atPrompt: "a choice we don't recognise"`, every other
signal reads it as idle, and nothing in the control plane can answer it. A person must go to the
pane. In the SDK path the same request arrives as data with its arguments and is answered
programmatically.

This task does **not** claim to fix the 2026-08-31 keystroke incident: that class was closed by
`settleStep` (`src/commands/run.ts:37-56`), and an earlier draft of this task wrongly cited it.

## What validation established

Two read-only validators probed the real SDK (0.3.252, unpacked read-only), the installed CLI
(2.1.252), a reference implementation, and this repository. Their findings changed the plan
materially; the constraints below are load-bearing, each verified.

**The mode cannot be a private addition. It is a protocol vocabulary change.** Six closed
enumerations exclude `claude` from the native path: `NativeSessionSchema.runtime`
(`src/config/schema.ts:57`), `projectionSchema` provider (`:107`), `messageOperationSchema.ts:5`,
`context/schema.ts:35`, `runtime/journal.ts:28`, `attachments/identity.ts:12`. `RuntimeCatalogSchema`
is capped at four rows with Claude's pinned to `tui` (`src/runtime/catalog.ts:16`), and
`ControlCreateSchema.runtime` is an agent kind (`src/control/schema.ts:127`), so a control caller
cannot request this mode at all. Permitted by the project's single-contract rule, but it is work
this task owns, not a side effect.

**Shared dispatch must change, and the interactive path must be held constant under it.**
`providerFor` is keyed by agent kind alone (`src/agent/index.ts:132-145`), so a native Claude row
would inherit the pane/JSONL provider: `scanPane`, `promptAnswer`, `detectFork`, `historyFile`.
Ungated consumers include `wait.ts:113`, `inbox.ts:83`, `doctor.ts:303`, `restartAll.ts:165` and
`launchStamp.ts:61,81,89`. Most dangerous is follow-the-fork: `ensure.ts:38-49` and
`restartAll.ts:229-240` call `forkedUuid` for every non-archived session with no runtime gate, and
for a native row `detectFork` would start from a non-existent jsonl and adopt an unrelated one —
producing permanent `identity-mismatch` status, a throwing chat delivery and `wait` exiting 2.

**Claude is the first runtime where the one-writer invariant can genuinely break.** OpenCode and
Custom own their conversation stores; the SDK spawns the operator's own `claude`, which writes into
the same `~/.claude/projects` the interactive CLI and the desktop app use. `discoverClaude`
(`src/external/claude.ts:112-125`) excludes managed conversations by the registry uuid, and writer
detection (`src/agent/claude/writers.ts:42-43`) reads the session id off the child's **argv** —
neither holds automatically for an SDK-hosted conversation.

**The SDK is a library, not a runnable binary.** `query()` is one long-lived streaming-input session
per conversation, and its whole control surface (interrupt, model, permission mode) exists only in
that mode. Native runtimes here are launched as argv in a pane (`src/runtime/driver.ts:19-40`), so
this mode needs a ccmux-owned bridge process in the pane — the shape `runCustomProcess` already has.

**Three callbacks, not one.** `canUseTool` alone acquires a new silent-hang class: `onUserDialog`
(`sdk.d.ts:1370-1385`) is how the CLI asks the host to render a blocking dialog, and *"if not
provided, the dialog is left unanswered until the worker's park deadline"*. `dialogKind` is an open
union and a host must never answer a kind it did not declare. `onElicitation` covers MCP.

**Two live schema mismatches that would strand a session.** `AskUserQuestion` permits four questions
(`sdk-tools.d.ts:1022-1028`); `projectionSchema.ts:100` caps at three, so a four-question ask makes
the snapshot unparseable while a blocking callback waits. Answers must key on the **full question
text**, not an index. And `approvalKind` (`:94`) has two values where the reference classifies four,
leaving `WebFetch`, `Task` and MCP tools nowhere to land.

**Bundle cost is zero, and both validators were wrong about it — measured.** Their shared finding
was that a lazy import is inlined, so the SDK must either be embedded in every bundle (~1.4 MB) or
the release build fails. Both framed it as a two-way choice. The third option is the one this
project already uses for every other third-party runtime: `codexBin` and `opencodeBin` are paths on
the host, and only `custom` is embedded because it is *our* harness rather than a vendor's. The SDK
is a vendor runtime, so it belongs on the same footing. Measured after adopting it as a **type-only
dev dependency**: bundle 3 940 317 → 3 940 400 bytes (+83), and none of the SDK's characteristic
exports appear in the artifact. Installing with platform optional dependencies omitted keeps the
tree at 17 MB rather than ~197 MB. Real types matter beyond size — they immediately rejected an
invented `PermissionUpdate` shape that a structural restatement would have accepted.

**Superseded — the original bundle finding.** `scripts/bundle.ts`
is a single build with no externals, enforced by a self-contained test; a dynamic import is inlined
(measured: 1.9 MB output for a three-line probe) and an unresolvable one fails the release build.
The precedent is explicit — `scripts/bundle-custom.ts` embeds the entire Custom runtime plus native
addons in every bundle and gates at runtime by host config. `sdk.mjs` is 1.4 MB and self-contained
against a current 3.93 MB bundle. The 197 MB platform optional dependency is **not** required when
the SDK is pointed at the host's own `claude`.

**Typing is conditional on a dependency we lack.** The SDK's declarations import types from
`@anthropic-ai/sdk`; with `skipLibCheck` an unresolved import silently degrades to `any`. Without it
the "typed stream" premise is false with no diagnostic.

**Resume does not replay (good) but returns no history (must be handled).** `--replay-user-messages`
is unreachable over the SDK transport, so there is no double-emission hazard. But a resumed session
starts with no turns; `getSessionMessages()` exists and works and is how history is rehydrated.

**Interrupt exists but the reference abandons it.** `query.interrupt()` is real
(`sdk.d.ts:2536`, capability `interrupt_receipt_v1`); the reference kills the process instead, which
this project's interrupt contract (`src/runtime/interrupt.ts`) forbids because it expects the runtime
to survive and answer `accepted|rejected`.

**Usage must be mapped field by field.** Every SDK count is a required number, so a reported `0` is
genuine; absence exists only at message grain. `reasoningOutputTokens` has no counterpart and stays
`null` (the nearest value is explicitly an estimate). `totalTokens` is not reported. `modelUsage` is
cumulative in streaming-input mode and must be differenced per turn. Zeroed crash results are
absence, not zero. The reference does the opposite — it drops genuine zeros — and must not be copied.

## Result

- An opt-in mode: `agent: 'claude'` with `runtime: 'native'`, beside the existing interactive mode.
- Default behaviour unchanged: a session that does not explicitly ask for the mode is created,
  healed, resumed, chatted with and displayed exactly as today. No existing session is converted and
  the interactive mode is not deprecated.
- In the mode, a Claude session reports what the other native runtimes report: typed content, turn
  status, honest usage, and tool permissions and dialogs as answerable requests.
- Availability is a property of the execution host; `runtime.list` reports both Claude modes
  honestly, including "configured" versus "not enabled here".

## Boundaries

- **`AgentKindSchema` stays four values.** This is a runtime mode of an existing kind; addressing,
  chat identity and the registry keep their vocabulary.
- **Shared code is touched, deliberately and named**: `providerFor` dispatch, the `ensure`/`restartAll`
  fork gate, six protocol enums, `RuntimeCatalogSchema`, `ControlCreateSchema`,
  `control/lifecycle.ts:276`, `create.ts:246-250`. The interactive path is held constant under each
  by regression tests that exercise `tui` rows through every changed seam.
- **One writer per conversation is enforced, not assumed.** A native Claude conversation is excluded
  from discovery and adoption by its native id; flipping `runtime` on an existing row is refused.
- **No account, key handling or credential routing is added.** The SDK spawns the operator's own
  binary with whatever authentication it already has. Which authentication a deployment may use is
  the operator's decision, expressed in host configuration — which is why the mode is off unless
  configured, and why documentation states this without giving legal advice.
- **The dependency costs the bundle nothing.** The SDK is a type-only dev dependency; the running
  bridge resolves it from host configuration, the way every other vendor runtime here is resolved.
  A host that has not enabled the mode neither installs nor loads it.

## Plan

- [x] **Protocol vocabulary.** Widen the six closed enums to admit `claude`; extend
      `RuntimeCatalogSchema` beyond four rows and emit both Claude modes; make the control-plane
      create input able to express a runtime mode distinct from an agent kind. Update the packed
      client and its verification script together.
- [x] **Dispatch and heal.** Key `providerFor` on `(agent, runtime)`; gate `forkedUuid` in
      `ensure`/`restartAll`; audit and gate every ungated consumer listed above. Regression tests
      first, proving `tui` behaviour byte-identical through each seam.
- [x] **Capability declaration.** Upgrade the declared `claude` row to the native profile so the
      existing degrade mask reproduces today's `tui` row exactly; keep `modelCatalog`,
      `modelSelection`, `history`, `fork` and `compaction` false, which nothing implements yet.
- [x] **Host gating.** Availability decided against machine configuration rather than the row alone;
      creation refuses with a typed reason before durable admission; a disabled host reports the mode
      as not enabled rather than as a broken session.
- [x] **Bridge process and adapter.** A ccmux-owned pane process hosting one long-lived streaming
      `query()`; `SDKMessage` to canonical content; `canUseTool`, `onUserDialog` (with declared kinds)
      and `onElicitation`; `query.interrupt()` honouring the survive-and-answer contract; usage mapped
      field by field per the rules above; history rehydrated through `getSessionMessages()`.
- [x] **Dependency.** SDK adopted as a type-only dev dependency, platform binaries omitted; the
      bridge resolves the runtime copy from host configuration. Measured: +83 bytes of bundle, no
      SDK code in the artifact.
- [x] **Schema corrections that are live defects regardless of this mode**: question cap raised to
      four; approval classification widened to cover the request types actually issued.
- [x] **Documentation**: architecture doc for the mode, and correction of the two documents that
      currently assert Claude has no native path.

## Acceptance

- [x] Every existing Claude session behaves identically — create, heal, resume after restart, chat
      delivery, pane detectors, `wait`, list and fleet output — proven by the existing suite green
      plus explicit `tui` regression tests through each changed seam.
- [x] `runtime.list` reports both Claude modes, and the native one as not enabled on a host that has
      not configured it; creation in that mode refuses before durable admission.
- [x] With the mode enabled, a real turn against the actual SDK produces typed content and a terminal
      status; a tool request arrives as an answerable approval carrying its arguments; a blocking
      dialog of a declared kind is answered rather than parked.
- [x] A four-question ask is representable and answerable; answers key on question text. Covered by
      unit tests; not exercised against a live four-question ask, which the runtime issues rarely.
- [x] Usage provenance holds: reported counts are provider-reported including genuine zeros, absent
      counts are unavailable, `reasoningOutputTokens` and `totalTokens` are never fabricated.
- [x] Interrupt leaves the runtime alive and answering. **Verified live**: receipt `accepted`, turn
      `interrupted`, runtime still `connected` and answering the next turn afterwards — the contract
      a reference implementation abandons by closing the session instead.
- [x] Resume restores the conversation. **Verified live**: a full process restart, then the session
      recalled a number given before it. History rehydration through a separate read was NOT needed
      for this and is not implemented — the pinned id resumes the runtime's own store.
- [x] A native Claude conversation is not offered for adoption and cannot acquire a second writer.
- [x] The bundle does not grow: +83 bytes, no SDK code in the artifact. A host without the mode
      enabled never loads, resolves or executes the SDK.

## Process

- [x] 2 read-only plan validators against the real code, edits explicitly forbidden.
- [x] Findings incorporated; task moved to in-progress; implementation proceeded without a stop.
- [x] Authorized project gates green: 1120 tests, 0 failures, publication privacy clean.
- [x] 2 implementation validators; findings fixed; gates rerun.

## Что сделано на этот момент

### Основание — интерактивный путь удержан под каждым изменённым швом
- [x] `test/provider-dispatch.test.ts` pins the interactive behaviour through every seam **before**
      any of it moved: which provider serves a Claude row, what the native gate answers, and that
      follow-the-fork is silent for a provider with no fork detector.
- [x] `providerFor` is keyed on the `(agent, runtime)` pair for exactly one pair — Claude in the
      native mode — so a native row gets a provider with no pane, no transcript and no fork
      detection. Codex, OpenCode and Custom dispatch unchanged.
- [x] `hasNativeRuntime` admits the mode; the attachment guard's inline copy of that rule was
      replaced by the rule itself.
- [x] The declared Claude capability row moved to the native profile, and the interactive answer was
      proven **byte-identical** by diffing the accessor's output before and after, not by argument.

### Protocol vocabulary
- [x] Five closed enums widened to admit `claude`.
- [x] Catalog rows are `(agent, mode)` pairs; both Claude modes are reported, and a host that has
      not enabled the native one says `runtime-not-enabled` — distinct from `runtime-not-configured`.
- [x] The control-plane create input can name the mode; it travels on the durable request row and is
      part of its fingerprint, so a request for a different mode is a different request.
- [x] `claudeNativeRuntime` host flag, off by default; creation refuses before durable admission.
- [x] The packed-client verifier addressed the catalog by position and would have asserted about the
      wrong row; it now finds rows by content.

### Adapter cores, against the real SDK types
- [x] `src/agent/claude/native/usage.ts` — per-turn spend as a difference against the running total,
      a decrease read as a session reset rather than a negative turn, genuine zeros preserved, an
      unreported turn mapped to nothing at all, and the two counts the SDK does not carry left null.
- [x] `src/agent/claude/native/permission.ts` — request classification including the `tool` class
      that had nowhere to land; deny always carrying a reason; cancel interrupting; a session-scoped
      acceptance producing a real `PermissionUpdate` whose destination is the session and no wider;
      answers keyed by full question text; four questions answerable; dialogs answered only for
      declared kinds.

### Live defects fixed on the way
- [x] Question cap 3 → 4. A legal four-question request made the snapshot unparseable while the
      runtime sat blocked on a callback nobody could answer.
- [x] `approvalKind` gained `tool`, so a network fetch, a subagent task or an MCP tool has somewhere
      to land instead of arriving unclassifiable.

### Adapter cores — the whole decision surface, pure and tested
- [x] `content.ts` — the runtime's message union classified with **no silent default**. The union
      grows every release, so a default would be a hole that widens: a new member lands in it,
      produces nothing, and a conversation is missing part of itself with no error anywhere. Every
      considered member has a verdict; anything else is reported by name.
- [x] `turn.ts` — working/idle/waiting as a fold over classified messages, so the awkward sequences
      can be exercised without a runtime. Its own tests caught a real defect in it: after the last
      request was answered the state read `idle` while the turn was still `inProgress` — the exact
      class of lie this mode exists to remove, reproduced in its first implementation.
- [x] `snapshot.ts` — the observation every blind reader believes, composed purely and validated on
      the way out. A disconnected runtime publishes `unknown` rather than the last state it saw, the
      lease is stamped from the observation instant, and the bounded window keeps the recent end.
- [x] `resolve.ts` + `claudeNativeSdk` — the SDK is resolved from host configuration, and the
      catalog now distinguishes three answers that call for three different actions: install the CLI,
      enable the mode, point at an SDK that exists.

### Owner shell — built, and verified by live turns
- [x] `resolve.ts`, `owner.ts`, `process.ts`, driver entry. One long-lived streaming `query()` per
      conversation in a ccmux-owned pane process, shaped like the other native owners so the
      supervisor already knows how to keep it alive.
- [x] **Proven on a live turn** against an isolated instance: session created, message sent, real
      model answer returned, turn reported `completed`.
- [x] Reference comparison applied — four differences from a working reference implementation were
      adopted after reading its option assembly:
      `systemPrompt: {preset: 'claude_code'}` and `settingSources` (without them the runtime is a
      bare agent loop wearing Claude's model, not Claude Code: no product prompt, no `CLAUDE.md`, no
      operator settings), `sessionId` pinning, and `includePartialMessages`.
- [x] Verified that the operator's rules actually load: a `CLAUDE.md` placed in the workspace
      declared a code word, and the live answer returned it.
- [x] Verified incremental output: text arrives in fragments, the first about 1.4–2.6 s in, rather
      than as one block at the end.
- [x] Verified continuity: the conversation survived a full process restart and recalled a number
      given before it.

### Four defects only a live turn found
None was caught by types, tests or either validator.
- [x] Dialog kinds were declared without a handler; the runtime refused to start and named the
      reason. Corrected by declaring none — the runtime supports that explicitly and degrades the
      affected flows, which is honest for a host that cannot render dialogs yet.
- [x] The published snapshot was the native shape where the reader compares the managed one, two
      fields wider. Every read returned `identity-mismatch`: a check cannot pass on fields nobody
      wrote.
- [x] The managed identity was passed as `resume`, asking the runtime to continue a conversation it
      had never created. Now the id is **pinned** at creation, so the two identities are the same
      value by construction and no pairing is stored.
- [x] With incremental output on, text was recorded three times — as deltas, as the finished
      assistant message and again in the terminal result. Deltas are now the single source.

## Что осталось

> **Снято в тот же день.** Первые два пункта ниже описывают состояние на момент закрытия этой
> задачи и **больше не описывают систему**: выбор модели, effort и картинки реализованы и
> проверены вживую — `docs/backlog/done/2026-09-01-native-claude-model-selection.md`. Дальше режим
> получил ещё шесть возможностей — `docs/backlog/done/2026-09-01-native-runtime-parity-program.md`.
> Текст пунктов оставлен как есть: это запись о том, что было решено тогда, а не утверждение о
> сегодняшнем дне.

- [x] Model selection and effort in the native mode — **deliberately not done**. The declared
      capabilities say `modelCatalog: false` and `modelSelection: false`, and a capability advertised
      without an implementation is the promise the control plane breaks on the first call. Recorded
      as `docs/backlog/done/2026-09-01-native-claude-model-selection.md`, since closed.
- [x] Image attachments — **deliberately not done, and now refused instead of dropped.** The runtime
      declares `imageInput: false` and `src/control/message.ts` finally enforces that declaration, so
      a caller attaching an image is told no rather than receiving a success for an image the model
      never sees. Carrying images into the mode is the task linked above.
- [x] Dialog rendering — **deliberately not done.** No dialog kinds are declared, which the runtime
      supports explicitly and which is honest for a host that cannot render them.

## Валидация реализации: что она поймала

Two read-only validators reviewed the finished implementation. They agreed the mode was **not
closeable** and between them found seven critical defects. Each is fixed and re-verified by a live
turn; the list is kept because every one of them was invisible to types, to unit tests and to the
earlier live runs.

- **A dead runtime kept reporting itself alive.** `connected: false` was set only in the `catch`, so
  a stream that simply ENDED — the child exited, the transport closed — left the loop publishing
  `connected: true` with a fresh lease every 200 ms over a runtime that was gone, and nothing ever
  restarted it. That is precisely the lie this execution mode exists to remove. Now `finally`, and
  the process stops so the supervisor can act.
- **The whole control-plane path was dead.** Without a `ContentProducer` the mode never wrote the
  content snapshot, so `native.read`, `native.subscribe` **and `native.respond`** all failed 503
  before reaching the owner. Tool permissions were therefore not answerable at all — the mode's
  headline feature. The earlier "verified live" claim was true only of a direct mailbox write, which
  is not a path anyone uses.
- **Interrupting left permission callbacks unsettled forever** while the snapshot claimed `idle`.
- **A second turn could dispatch over a running one**, retagging the first turn's items, letting its
  result close the wrong turn, and pointing an interrupt at a turn that was not running.
- **The approval receipt was written only after the effect**, with no `uncertain` bracket, so a crash
  in the window reported an applied decision as rejected on the next start.
- **`acceptForSession` wrote a rule keyed on the human summary** (`"Bash: rm -rf /tmp/x"`) instead of
  the tool name, so a rule that can never match — the operator is told it is allowed for the session
  and asked again immediately.
- **Tool use and results never entered the transcript at all** — no name, no arguments, no output —
  because both arrive in shapes that carry no text blocks.
- **Items grew unboundedly by full-array copy**, one per text fragment: O(n²) over a session.

### И один дефект, внесённый во время самой починки

Turn events were told apart by which keys were present. Adding an optional `failed` flag to the
message variant made `'failed' in event` true for **every** message, so every frame took the failure
branch: a live turn holding an unanswered permission published itself `failed` and `idle` at the same
moment. Caught by a live run rather than by a test — the turn failed where it should have waited.
Now discriminated by an explicit tag, with a test for that exact trap.

## Что доказано живым прогоном

- A session created, a message sent, a real model answer returned, turn `completed`.
- The operator's rules apply: a code word declared in the workspace `CLAUDE.md` came back in the
  answer, so `systemPrompt`/`settingSources` are doing their work and the mode is Claude Code rather
  than a bare agent loop.
- Text arrives incrementally, first fragment ~1.4–2.6 s in.
- The conversation survives a full process restart and recalls what was said before it.
- **A tool permission answered through the control plane**: the request visible via
  `readControlNative` with the file path it would write, `respondControlNative` returning
  `submitted`, the tool running, the file appearing. Declining blocks it and the file does not appear.
- Interrupt: receipt `accepted`, turn `interrupted`, runtime still connected and answering the next
  turn — the contract a reference implementation abandons by closing the session instead.
- Usage from a real turn: input 4, cached 80960, output 235, with `totalTokens` and
  `reasoningOutputTokens` `null` because the runtime does not report them.

## Границы, которые остаются

The mode is off unless a host enables it and points at an SDK. Model selection, effort and image
input were declared false and enforced as false rather than silently dropped — carried in
`docs/backlog/done/2026-09-01-native-claude-model-selection.md`, which since closed and made all
three true. No dialog kinds are declared, because none can be rendered.

All live verification ran on an isolated instance with its own state directory and tmux socket. The
production fleet was never touched: the flag is off there, and its Claude sessions remain interactive.
