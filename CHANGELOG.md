# Changelog

All notable changes to ccmux. The `[Unreleased]` section accumulates as work lands;
`bun run release X.Y.Z "notes"` rolls it into a dated version section, and CI publishes
the GitHub Release with that section as the notes.

## [Unreleased]

## [0.49.7] — 2026-09-02

A transcript read costs its window, not the whole file
## [0.49.6] — 2026-09-02

A plan window ends on the clock, and an ended one is not served as current
## [0.49.5] — 2026-09-02

Every command loads at its case, and the status line's own cost is counted
## [0.49.4] — 2026-09-02

A pending request too large for the wire sheds instead of killing the stream
## [0.49.3] — 2026-09-02

A rejected service result says which fields it could not read
## [0.49.2] — 2026-09-02

A run from a checkout writes its own record, not the machine's history
## [0.49.1] — 2026-09-02

The native stream frame budget comes from the wire, not from this project's constant
## [0.49.0] — 2026-09-02

A held message publishes why, as a value and not only as a sentence
## [0.48.1] — 2026-09-02

The native stream frame budget is measured on the line a consumer reads
## [0.48.0] — 2026-09-02

A supervisor that gives up on itself is not self-healing
## [0.47.9] — 2026-09-02

A machine that stopped checking says so, and a zombie counts as exited
## [0.47.8] — 2026-09-02

A recorded diagnostic is reachable by the name an operator has
## [0.47.7] — 2026-09-02

A schema that cannot answer is treated as having nothing to say, and a child that crashed is named as crashed
## [0.47.6] — 2026-09-02

Check a request against the contract the client speaks
## [0.47.5] — 2026-09-02

Answer a retried create from its receipt instead of calling it busy
## [0.47.4] — 2026-09-02

Stop waiting for a lock nobody is waiting for
## [0.47.3] — 2026-09-02

Tell every letter behind a gate what the gate is
## [0.47.2] — 2026-09-02

Name the fields a refused request got wrong
## [0.47.1] — 2026-09-02

Say what a live session leaves behind when its directory moves
## [0.47.0] — 2026-09-02

Carry the conversation with the directory; stop calling a whole answer a fragment
## [0.46.0] — 2026-09-02

Mail waits for the recipient's turn boundary, and several letters arrive as one
## [0.45.0] — 2026-09-02

Move a session's registered directory without recreating it
## [0.44.0] — 2026-09-02

One session row for list and fleet, so a field cannot arrive on one path and vanish on the other
## [0.43.8] — 2026-09-01

Keep a large JSON answer whole when the reader is slower than the writer
## [0.43.7] — 2026-09-01

Keep a large JSON answer whole when the reader is slower than the writer
## [0.43.6] — 2026-09-01

Bound the test suite at twenty seconds so a busy machine is not a failing gate
## [0.43.5] — 2026-09-01

Read the account when a limit moves, instead of publishing the pushed figure
## [0.43.4] — 2026-09-01

Identify a plan window by its limit and length, so a pushed update cannot overwrite another window
## [0.43.3] — 2026-09-01

Keep every plan window a pushed update is silent about
## [0.43.2] — 2026-09-01

Group a plan by provider and account, so two runtimes on one address are two budgets
## [0.43.1] — 2026-09-01

Keep the per-model plan windows, and name a window by its model
## [0.43.0] — 2026-09-01

Publish how much of the plan each account has left, and seed native Claude admission selection
## [0.42.0] — 2026-09-01

Answer the model catalog without a session, and carry which window a context fill was measured against

Two things a fleet consumer could not do, both asked for by a consumer that hit them.

- `models({ runtime: "claude" })` answers without a session. The list a caller needs to choose a
  model existed only inside a running session, and the session is created WITH the choice — a
  circle with no way out, which sent callers off to hardcode model names. The way out is that the
  list is not a property of a conversation at all: it is what the installed CLI and the operator's
  settings offer, and every owner on the host is handed the same one before its first turn. The
  host answer is the newest catalog any owner published, carrying when it was observed and whether
  its publisher is still running. `stale` is a description, not a failure. A host that does not run
  the mode still says so, which is a different answer from an empty list.
- `context` in `list --json` and `fleet --json` carries `window` and `rawLimitTokens`. The runtime
  measures both the model's ceiling and the narrower window a compaction policy imposes, and the
  projection kept only the percentage — so a reader watching the fleet saw a number it could not
  attribute, and the next step is inferring the ceiling from the model's NAME. A source that cannot
  know, such as a fill scraped from a status line, reports absence rather than `model-limit`.
## [0.41.0] — 2026-09-01

One mechanism where there were four, one table where there were twelve, and the task queue moves out

Internal consistency pass, plus two defects it uncovered.

**Contract changes** — this project keeps one current contract and has no installed-client
compatibility population, so these replace rather than extend:

- `permission-mode` now requires an `operationId`, like every other durable request. A repeated
  request is one request; without it, a caller whose answer was lost restarted a mode change against
  a session that had moved on.
- `list --json` and `fleet --json` rows carry `waitingFor`: the session a session is waiting for,
  while it waits. Null means "not waiting" locally and "that build does not report it" from a fleet
  peer, the same distinction already drawn for `turnStartedAt`.
- The codex `effort` turn option is a bounded string rather than a fixed set of names, matching the
  claude one. Which levels exist is a property of the model and is published per model in the
  catalog, which is what accepts or refuses one. This widens the published packed-client type.

**Fixes**

- A native Claude turn whose dispatch was cut short by a crash no longer parks the session forever.
  The phase file recorded that a dispatch was in flight and nothing ever looked at it again, so the
  turn sat unsent and its sender waited for an acknowledgement that could not come. The runtime's
  own transcript now decides whether the turn arrived, bounded by when the dispatch began.
- The native Claude pickup takes the admission lock that its writers already took, so a write can no
  longer interleave with the read-then-write that moves a turn between phases.
- A session's permission mode survives a restart across this upgrade: the record is read in the
  shape an earlier build wrote it. Losing it would have returned a session in `plan` or
  `acceptEdits` to `default` — a drop towards the mode that asks less.

**Internal**

- One durable-mailbox mechanism serves interrupt, permission mode, MCP control and rewind; one table
  answers which execution modes each agent has; one function computes every idempotency fingerprint.
  Fifteen unused exports and two pass-through re-exports are gone.

**The task queue is no longer in this repository**

- This repository is the deliverable. The project's task queue — every state, including the closed
  work — now lives in the project's private working repository, and `docs/backlog/` and
  `docs/research/` are gone from here. A supervisor of agent sessions accumulates a backlog made of
  the things a public repository must not hold: machine names, session names, fleet addresses, and
  the neighbouring project whose failure produced the task. Every one of those tasks had to be
  anonymised on the way in, and an anonymised claim is unverifiable a year later.
- The consequence for readers of this repository is stated rather than hidden: this tree can no
  longer answer "why" from a task. Anything whose reasoning deserves to be public has to become a
  decision record in `docs/decisions/` or a comment at the mechanism, and the bar on both goes up.
- The publication guard gained two rules. One rejects an address of the form `<machine>:<session>`
  handed to a `ccmux` command — a shape that had already reached a committed document and that no
  structural rule caught, because it is not a path, not a frontmatter field and not a machine label.
  The other rejects the private companion's repository address; generic placeholders and this
  project's own public names, including the from-source launcher, stay valid.
- `quality.config.json` declares this repository's identity, role and content classification in
  typed form, for a reader that checks the boundary from outside.
## [0.40.0] — 2026-09-01

An optional native Claude runtime, and the control every session was missing

An optional native Claude runtime, and the control every session was missing

- Add an opt-in native execution mode for Claude beside the interactive one, on the published agent
  SDK. It is off unless a host enables it and points at an SDK; nothing changes for a host that does
  not. The mode runs as Claude Code rather than as a bare agent loop — the product system prompt and
  the user, project and local setting sources are requested, so `CLAUDE.md` and the operator's
  settings apply exactly as they do in a terminal. It brings a typed stream, structured approvals
  answerable through the control plane, interrupt, model selection, reasoning effort and images.
- Publish what a session can run from the session that can ask. The model catalog, the slash-command
  vocabulary and the account are written by the owner process beside its status, because only it
  holds a connection and a reader elsewhere would have to invent the list. Effort levels are
  published per model: some models accept five and some accept none, which no fixed list in this
  code could have expressed.
- Refuse a turn option against the catalog rather than against a runtime's name. The reasoning-effort
  check was written as a branch for one runtime, so every native Claude turn carrying an effort went
  through unvalidated. The same shape had put a runtime name in four other decisions — the model
  catalog answered for the wrong execution mode, a fork was refused by a list of agent names, model
  selection was refused for an entire agent, and a fixed set of effort names sat beside the catalog
  that actually knows them. All five now ask the declared capability.
- Give a native session the ordinary controls it lacked. A slash command runs as a turn of its own,
  delivered through the runtime mailbox and deliberately not through the chat ledger — ledger
  delivery frames every message with its sender attribution, and a command carrying that prefix is
  no longer a command. The permission mode is published and settable, applied between turns, and
  restored on restart: a session given `plan` came back up in `default` while its own record said
  otherwise, and the drop went from a mode that asks before writing to one that asks less.
- Read context fill from the runtime instead of parsing it out of a statusline, and carry which
  window it was measured against — a model's hard limit and a smaller compaction window mean
  different things at the same percentage. The fleet slice now carries the field it was dropping, so
  a consumer watching every machine can read context fill for all of them and not only the local
  ones.
- Serve history, compaction and fork for the native Claude mode from the transcript the runtime
  writes, which is the source of truth for a conversation. Compaction is the runtime's own command
  on the path above, and its boundary is read from the record the runtime writes rather than
  inferred from a token count dropping. Rollback stays refused: the runtime will not un-say a
  conversation.
- Say which session is spending whose account, across the fleet, because a limit belongs to an
  account rather than to a machine. What travels is an identity — never a token, a key, or the name
  of where either lives.
- Add file checkpoints and rewind behind a per-session option, off by default. A caller can preview
  what a rewind would restore and then perform it; a path the runtime refuses to restore is reported
  rather than counted as success. This is the one place the project answers for the working tree and
  not only for the conversation, which is why it is a decision somebody makes rather than a default
  somebody discovers.
- Expose a session's MCP servers and let one be enabled, disabled or reconnected. Their
  configuration is not read at all: the URL, headers and any token the host put there have no
  business in a status projection.
- Carry an image in a transcript as an address instead of the word `[image]`. The word was a picture
  replaced by a string nothing could turn back into one; a message now names the media type, size
  and digest, and `ccmux transcript <name> --image <address>` returns the picture. An image that
  cannot be fetched says which way it failed, because "unreadable" and "there was no image" call for
  different reactions. The bytes stay off the record, so a listing keeps costing what it did.
- Carry what an answer cost on the answer. The source reports usage on every assistant message and
  exactly one number was taken from it; a turn's input, output and cache tokens are now on the
  message, and a line that carries no usage reports unknown rather than zero.
- Drive the transcript pane by the file rather than by a clock. What a reader waits for is a write to
  the conversation, and on an interval alone the wait was up to a poll long for no reason but the
  interval. A slower timer stays as a backstop, because a watch misses events on some filesystems and
  a transcript that quietly stops updating is worse than a late one.
- Keep a diagnostic from destroying the one that explains it. Diagnostics were one file per session,
  so a generic wrapper written a moment after the real cause overwrote it and left only "requires
  reconciliation" without saying of what. The key now includes the stage — which is what revealed why
  a fork was being refused.
- Stop two tests from asserting the machine's speed. Both passed alone and failed inside the full
  suite on a busy box, which makes a green suite a coin flip rather than a signal.
## [0.39.42] — 2026-08-31

Answer a startup menu once, never twice into the same pane

- Answer a blocking startup menu once instead of every second until the watch window expires. The
  settler kept no memory of what it had pressed and required no evidence that the press changed
  anything, so it re-answered while the detector matched: 86 keystrokes over four days, all the
  same key, across ten sessions, up to eight into one of them. When the menu was gone but the pane
  still matched, that key reached a live composer — where it silently holds every message addressed
  to the session, or, with the confirming Enter, is submitted as a turn nobody wrote. Both were
  observed. Two menus in a row are still both answered, because a pane seen with no menu on it is
  what proves the second is a different menu.
## [0.39.41] — 2026-08-31

Read parked sessions honestly, verify declared registries, name the local server

- Read a row's state by one rule wherever it came from: an archived session that is not running
  reads `archived` in the fleet map, as it already did locally. The map printed a peer's raw
  run-state and called sixty-one deliberately parked sessions `stopped`, which reads as live
  sessions that had fallen over. Parked rows are now counted rather than listed (`--all` prints
  them, `--json` is never folded); the live fleet map went from 96 rows to 35.
- Query `lsof` only for thread lock files that exist, since it walks every process before examining
  any path and a discovery poll asks about every recorded thread. Lock inspection over two thousand
  threads: 4021 ms to 3 ms; the whole inventory read 6846 ms to 402 ms. What this gives up — a live
  holder of an unlinked lock — is stated in the architecture doc.
- Add `ccmux models <launch-recipe-id>` to check a declared model registry against the provider that
  must serve it. Diagnostic only: an unreachable provider reports `unknown`, never `missing`, and a
  context window the provider never published stays declared and unverified rather than agreed.
  Three outcomes, three exit codes.
- Let a local provider carry a host-declared `label` naming the server behind it, reported in the
  catalog page and the applied profile. `local` says the address was checked and cannot say which
  engine answered; the label carries that half without entering `selection.provider`, which is
  matched against the host adapter.
## [0.39.40] — 2026-08-31

Compose a host-owned local model provider for the Custom runtime

- Compose a host-owned local model provider in the Custom runtime: the launch recipe's provider is
  now `openrouter` or `local`, the local kind reaching an OpenAI-compatible model server through the
  published adapter with an optional credential. Endpoint and credential stay in host configuration
  and reach no catalog page, selection evidence or caller input.
- Decide locality from the address literal rather than the label: `localhost`, loopback, private and
  link-local addresses only, with no embedded credential, query, fragment or name resolution, so a
  public endpoint cannot be declared local and the provenance the catalog publishes is a fact.
- Preserve what a local server reports about usage and what it omits: counts it sends are
  provider-reported, counts it does not stay unavailable, and cost is unavailable rather than zero.
- Batch thread-lock inspection by argument bytes instead of a fixed count and group each `lsof`
  answer once instead of re-scanning it per path, since `lsof` walks every process before it
  examines any path. Discovery over two thousand threads: 7171 ms to 4021 ms on a busy host.
## [0.39.39] — 2026-08-31

Qualify remote image control and close native harness acceptance

- Qualify remote managed Codex/OpenCode image input through the typed service client, including
  ordered PNG/JPEG, image-only input, near-limit images, exact message/turn correlation and retained
  previews. Fixture input explicitly uses conversation-only notification audience.
- Enforce structural publication privacy for current Markdown and staged additions, with safe
  file/line diagnostics, generic regression fixtures and no embedded private-identifier denylist.
- Isolate monitoring row-limit acceptance from host home automount lookups without increasing
  test timeouts or changing production monitoring behavior.
- Renew synthetic native-producer evidence between independent stream connections and explicitly
  verify expired evidence still refuses; preserve production freshness and replay contracts.
## [0.39.38] — 2026-08-31

Drain resident native streams during managed shutdown

- Adopt Stitchkit 0.70.5 so managed shutdown cancels and drains open native HTTP streams before
  closing the control resource, without a second lifecycle or caller-side cancellation workaround.
- Qualify clean daemon replacement with a subscribed native reader, retained image input and
  exact message correlation; preserve supervised provider writers and session identities.
## [0.39.37] — 2026-08-31

Preserve message origin, typed feeds and explicit notifications

- Export browser-safe snapshot/feed and endpoint schemas from the existing typed client, with one
  canonical definition shared by runtime readers and packed Bun/Node/browser consumers.
- Include the origin/audience cutover and capacity-fixture qualification from the unpublished
  candidates: conversation traffic is quiet, explicit notices remain available, and accepted images
  plus retry identity survive daemon restart.
## [0.39.36] — 2026-08-31

Preserve message origin without notification echo

- Publish host-bound application attribution, honest native framing and structured message/feed
  identity. Preserve accepted input, attachment ownership and exact idempotent retry after restart.
- Make conversation input and peer coordination quiet by default; keep explicit owner notices
  and external courier routes. Historical missing origin remains unknown and does not replay.
- Qualify full-capacity admission with a schema-checked persisted fixture instead of hundreds of
  setup rewrites. Keep the original test deadline and assert that refusal leaves the journal intact.
- Supersede the unpublished 0.39.35 candidate, whose tag gate caught the fixture timeout.
## [0.39.35] — 2026-08-31

Preserve message origin and explicit notification audience

- Separate authenticated service ingress, application-attested author and notification audience.
  Host-bound attribution and exact registration generation are retained with message identity;
  conflicting retries cannot change context or escalate notification intent.
- Stop automatically mirroring conversation input and peer coordination to Telegram. Explicit
  owner notices and external courier routes remain available; historical unknown origin is quiet.
  Suppression advances the cursor, while uncertain sends retain the existing retry semantics.
- Preserve machine-scoped attachment uploads, accepted image pins and operation receipts across
  the ingress cutover. Snapshot/feed retain message IDs, structured endpoints and accepted origin.
## [0.39.34] — 2026-08-30

Custom harness, exact runtime identity and bounded external history

- Run optional Custom sessions with the published Stitchkit headless harness, canonical SQLite
  history, immutable host tools/resources and exact signed approval continuations. Preserve
  one-writer create/message retries, restart identity, bounded live evidence and private diagnostics.
- Qualify Stitchkit 0.70.2 with sequential approvals, real coding/denial/defer/interruption and
  installed runner packaging. Keep native Codex/OpenCode execution engines unchanged.
- Require model catalog execution-runtime identity independently of model provider, and validate
  required transport fields while retaining owner idempotent chat retry after unknown delivery.
- Add bounded read-only external authored-text history and explicit control eligibility. Exact
  provider/host/thread cursors refuse changed storage; reads never create or take over a writer.
## [0.39.33] — 2026-08-30

qualify native approval acceptance

- Qualify native approval acceptance with a narrow host-owner fixture mandate and fail immediately
  if the native turn settles without requesting permission. Verify cancellation against the published
  runtime/client and record completed tool-outcome and suspended-request acceptance.
## [0.39.32] — 2026-08-30

preserve native tool outcomes and suspended cancellation

- Preserve bounded typed native tool identity, name, lifecycle, outcome and observed exit code in
  content, replay and history. Distinguish nonzero shell exits and native failures/interruption from
  lifecycle completion; missing result evidence remains explicitly unknown.
- Align OpenCode live/history part and call identities, preserve terminal tool evidence through
  reconnect and late updates, and verify both native runtimes through the published client surface.
- Expose bounded native filesystem approval scopes, separating the immediate request from a
  session-wide grant. Preserve explicit missing/omitted context without publishing tool bodies.
- Require native generation on exact turn interruption; allow cancellation while awaiting approval
  or input. Retire pending requests on native terminal evidence without accepting permission or
  archiving the conversation, and refuse stale turns/generations without a second abort.
## [0.39.31] — 2026-08-30

complete native process-group cleanup

- Keep owned native process-group cleanup active when a zero-signal probe reports permission
  denial. Only an absent group completes the liveness check; real termination errors still fail.
## [0.39.30] — 2026-08-30

retain exact native message correlation

- Add caller-scoped `message.operation` to both typed control clients and the declared service.
  Retained receipts bind exact message UUIDs to managed registration, native session, turn and
  terminal outcome across reconnect and daemon/provider restart. Queued, uncertain, expired and
  unavailable evidence stay explicit; reads never resubmit or infer bindings from text/order.
- Bound receipt storage and expose its retention limits. Preserve pending operations and reject
  capacity exhaustion before queue admission. Cover both native runtimes and packed Bun/Node clients.
## [0.39.29] — 2026-08-30

verify late approvals through native terminal pickup

### Fixed

- Keep native acceptance approvals serviced until both cross-runtime message pickups complete;
  distinguish a durable reply from terminal processing and cover late approval and failed outcomes.
## [0.39.28] — 2026-08-30

publish native content before runtime readiness

### Fixed

- Commit the initial native content baseline before Codex/OpenCode readiness becomes visible.
  Immediate reads after managed create no longer race the first coalesced content write; write
  failures refuse admission, and native events remain buffered during initial publication.
## [0.39.27] — 2026-08-30

use unversioned control API and enforce Biome checks

### Changed

- Use one unversioned public control surface: `/ccmux/control`, owner ingress
  `/ccmux-control/invoke`, descriptor revision `current`, native profile `ccmux-native` and `ccn_`
  cursors. Replace numbered bindings and reconnect with a fresh cursor; no legacy aliases are kept.
  Durable managed identities, accepted operations and native history are preserved.
- Enforce Biome 2.5.11 formatting and recommended lint rules in the complete local/CI gate.
  Align source, tests and tooling on two-space indentation, single quotes and a 100-column width.
- Keep cleanup failures explicit without throwing from `finally`, and replace unchecked probe
  assertions and ambiguous return expressions with typed guards and direct control flow.
## [0.39.26] — 2026-08-30

exclude native internal context from public history

### Fixed

- Keep native synthetic context and compaction-summary text out of public OpenCode history/content.
  These runtime-generated parts can contain internal tool inputs and attachment-store paths. Preserve
  explicit history omission counts and ordinary authored conversation text without heuristic rewriting.
## [0.39.25] — 2026-08-30

add native images, replay, selection and context controls

### Added

- Send validated PNG/JPEG attachments through authenticated upload, immutable references and native
  image input. Preserve exact input order and retained previews across retry, fork and restart.
- Stream bounded native conversation content with stable item offsets, replay cursors, explicit
  gaps/truncation, native terminal evidence and bounded slow-reader recovery.
- Select persistent session defaults or per-turn model/mode options without replacing managed
  identity. Separate accepted defaults from observed native settings and model rerouting.
- Read bounded native history, fork native context and explicitly compact it with durable operation
  identity. Expose exact Codex steering; refuse unsupported steering and rollback capabilities.
- Apply immutable owner-defined instructions, skills and agent policy with safe native provenance.

### Changed

- Replace the prior control contract with service revision 2 and native profile `ccmux-native-v2`.
  This is one current API: obsolete routes, aliases and parallel compatibility clients are removed.
  Update transport bindings and clients from the published descriptor before enabling remote calls.
- Native Codex ownership now requires version 0.151.0 or newer. Preserve durable session identity,
  native history and accepted work; do not migrate sessions by starting unrelated conversations.

### Safety

- Keep native history work cancellable and separate from heartbeat/approval handling. Preserve one
  writer, bounded unresolved RPCs, exact compaction completion and fail-closed uncertain mutations.
- Decode complete images with bounded resources; keep image bytes, private paths, credentials and
  provider diagnostics outside public metadata. Retain exact failure causes in private owner evidence.
- Verify real image, selection, policy, history, steering and streaming flows on both native runtimes;
  operation-specific unsupported capabilities remain explicit rather than advertised as full IDE parity.
## [0.39.24] — 2026-08-30

add managed OpenCode and capability-aware runtime control

### Added

- Discover execution runtimes and explicit capabilities through `runtime.list` and typed clients;
  select runtime independently of model provider/model while preserving default Codex creation.
- Supervise authenticated OpenCode servers through the pinned native SDK and bounded SSE, with
  stable managed/native identities, native configured-model catalogs and exact approval/input control.
- Reuse the existing chat ledger for cross-runtime messaging, busy/defer, wait, interruption and
  restart/resume. Preserve provider writers across daemon restart and native history on archive.

### Safety

- Reconcile uncertain native create/prompt receipts without replaying side effects. Repair the
  cursor/mailbox crash gap only with positive terminal evidence; corrupt/uncertain state fails closed.
- Bound HTTP frames, SSE admission, native history and projections. Keep raw provider errors and
  tool payloads out of the public feed; retain bounded private diagnostics for the execution host.
- Preserve existing Claude/Codex behavior. The optional custom harness remains explicitly unavailable
  pending its published dependency and real acceptance; no substitute agent loop is shipped.
## [0.39.23] — 2026-08-30

discover models before first chat and preserve native selection

### Added

- Read the native Codex model catalog before creating a conversation, with explicit host or exact
  session source identity and bounded metadata-runtime cleanup.
- Select a typed provider/model independently of a host launch recipe; retain it in create
  idempotency, native admission, restart and safe control projections.
- Add bounded, read-only `directory.list` and typed `directories` clients for workspace pickers,
  with hidden-file opt-in, symlink refusal and directory-versioned pagination.

### Fixed

- Connect session catalog reads to their exact owned runtime instead of an unrelated machine socket.
- Preserve the loaded thread model when applying Plan and other native collaboration presets.
- Do not request historical turn pagination for a freshly created thread; observe its bootstrap
  on the existing native subscription instead of racing thread-store materialization.
## [0.39.22] — 2026-08-29

expose the provider-owned Codex model catalog as a bounded control read

### Added

- Expose the provider-owned Codex App Server `model/list` contract as a bounded read-only control
  operation (`POST /control/models`, dot-form effect `model.read`, typed `models` client method).
  A call forwards `cursor`, `limit` and `includeHidden` to the connected runtime of one exact
  owned App Server session and returns one deterministic page plus the provider's `nextCursor`,
  carrying only selector metadata: id, display name, description, default/hidden markers, input
  modalities, service tiers and supported/default reasoning efforts.

### Fixed

- Fail the model-catalog read closed on provider errors, deadline, malformed or oversized pages
  instead of reporting a partial or substituted catalog; unknown identities are refused before any
  provider contact, and no credentials, paths, argv or machine configuration cross the response.
## [0.39.21] — 2026-08-29

add managed collaboration policy

### Added

- Let an immutable host launch recipe select an installed Codex collaboration-mode preset for
  every CCMux-started managed turn. Plan-policy sessions can now emit native `request_user_input` requests that
  the existing exact response channel can answer; callers still send only recipe id and revision.

### Fixed

- Probe the installed provider's collaboration-mode catalog before persisting a turn pickup or
  starting a turn. Unsupported policies fail closed without a false pending request, while
  recipe-less/default sessions keep their existing behavior.
## [0.39.20] — 2026-08-29

add server-owned launch recipes

### Added

- Add server-owned launch recipes to managed `session.create`. Callers select only an immutable
  id/revision; the execution host resolves existing session env files and allowed native Codex
  model-provider flags, pins a canonical digest through create/restart reconciliation and exposes
  only safe recipe metadata in receipts and resident projections.

### Fixed

- Refuse unknown, removed, changed or unavailable launch recipes before registry mutation or
  provider spawn. Recipe creates cannot mix caller flags, leak secret values into argv/projections,
  or turn a late retry into a second writer.
## [0.39.19] — 2026-08-29

bound managed creation and installed transports

### Fixed

- Make idempotent managed Codex creation tolerate the provider's rollout publication boundary.
  The bootstrap turn now retries only the named empty-metadata failure, after an exact committed
  `session_meta` record and persisted client-ID check, without minting another writer.
- Make the published native-stream profile execute the standard installed command with an empty
  environment. Install and daemon convergence now publish an atomic PATH-independent POSIX shim,
  while isolated runtimes cannot repoint the shared entrypoint.
- Bound local Unix RPC request, header and response bytes with one deadline through body completion
  and owned transport cleanup. Preserve version, refusal, command and no-fallback semantics using
  the public Stitchkit transport already shipped by CCMux.
## [0.39.18] — 2026-08-29

make control service effects policy-compatible

### Fixed

- Make revision-1 control-service effects valid declared-service authorization identifiers and
  keep descriptor, typed-client metadata and packaged JSON on one exact dot-delimited mapping.
  Packed Bun/Node consumers now verify the transport policy shape and descriptor-file parity.
## [0.39.17] — 2026-08-29

publish declared service ingress and native stream adapter

### Added

- Publish a versioned declared-service descriptor, strict private ingress and transport-injected
  typed client for bounded managed session control. Local and declared-service calls share the
  same operation admission, durable receipts, registry and native provider writer.
- Add a fixed stable-cursor NDJSON native stream producer with target-bound resume cursors,
  explicit generation/gap resets, heartbeats and cancellation. Release the Bun/Node client
  package with descriptor/profile metadata, declarations and SHA-256 integrity.
## [0.39.16] — 2026-08-29

add workspace-scoped Codex control surface

### Added

- Add typed same-user control operations for idempotent workspace-scoped Codex creation, exact
  archive/stop receipts and bounded generation/cursor native item streams.
- Answer exact current App Server approval and user-input requests through the resident supervisor;
  stale identity, generation, request and changed idempotency payloads fail closed.

### Fixed

- Reconcile concurrent or ambiguous create retries to one registration generation and provider
  writer. Distinguish response submission from provider resolution and require explicit resync
  after writer generation changes.
## [0.39.15] — 2026-08-28

drain automatic updates before daemon restart

- Fix automatic update shutdown: install and verify first, settle the healing run, then request
  normal daemon shutdown. The daemon no longer waits on the service manager restarting itself.
## [0.39.14] — 2026-08-28

publish resident external native session status

- Add daemon-owned external native status through `control external`, `control watch-external`
  and the typed control client. One bounded provider connection serves all readers; native
  events, snapshot reconciliation and five-second leases keep execution separate from availability.
- Preserve unknown state for inaccessible Desktop runtimes and unloaded threads. Reconnect,
  malformed input, deadline, expiry and host failures cannot retain false working or idle claims.
- Adopt Stitchkit 0.68.5 and use its configured HTTP adapter for resident control streams.
  Verify post-header cancellation, quiet pending reads and reusable Unix connection capacity
  without adding a consumer cancellation shim or changing session ownership.
## [0.39.13] — 2026-08-28

add typed resident control and managed daemon lifecycle

- Add a typed same-user Unix control API, generated CLI/tool proxy and bounded resident session
  streams using Stitchkit. Release a self-contained `control-client.js` with SHA-256 verification.
- Compose daemon observation, chat delivery, healing and control resources under one bounded
  lifecycle; supervised conversations keep their identities and provider processes across restarts.
- Keep exact identity, durable message deduplication and native approval/input/partial-composer
  admission. Native waits follow delivery rather than inbox-read cursors; resident waits require
  a fresh observation after their call begins.
## [0.39.12] — 2026-08-28

own native Codex App Server sessions

### Added

- Opt-in `new --agent codex --runtime app-server`: native process ownership, private Unix
  transport, an attached native terminal client and deterministic resume of the provider UUID.
- Native working/idle/approval/input state, bounded connection generations and event cursors,
  `runtime <name> --json`, and a self-contained `codex-runtime-reader.js` release asset.
- Managed chat through native turn operations with durable message intent, exact receipts,
  fail-closed busy/composer/approval boundaries, deferred delivery and interruption-aware wait.

### Fixed

- Provider launcher crashes dispose the entire owned process group before resuming, preventing
  orphaned native writers and inherited pipes from stranding supervision.
- Shared external writers are classified at the correct terminal-multiplexer boundary;
  supported native prerelease versions retain bounded turn-state observation.

Existing TUI sessions and official Desktop-owned conversations are not migrated by this opt-in mode.
## [0.39.11] — 2026-08-27

separate external turn state from writer ownership

### Added

- Independent external `turnState` evidence and a `TURN` table column, separating native execution
  from shared writer ownership. Includes working, idle, approval/input wait and explicit unknown,
  unavailable and stale outcomes with timestamps and provenance.
- Bounded read-only App Server status observation without thread mutation or transcript scans;
  unsupported runtimes fail closed. Existing ownership and adoption semantics are unchanged.
## [0.39.10] — 2026-08-27

read monitoring status natively without CLI processes

### Added

- `ccmux/monitoring-reader`: native asynchronous monitoring reads for resident applications,
  without a CLI process, transcript scan or additional observation pass per read.
- A self-contained `monitoring-reader.js` release asset with SHA-256, shared configuration
  resolution and protocol validation, independent deadlines/cancellation, bounded concurrency
  and no completed-snapshot cache. Root changes and unsafe/stale/unavailable data fail closed.
## [0.39.9] — 2026-08-27

preserve rollback during concurrent updates

### Fixed

- Concurrent manual and automatic updates serialize bundle swaps. Installing identical bytes
  preserves the previous rollback bundle; a failed backup aborts the swap.
## [0.39.8] — 2026-08-27

publish bounded resident monitoring status

### Added

- `ccmux status --json` reads a bounded managed-session snapshot published by the existing
  daemon. Concurrent readers share observations without opening transcripts or capturing panes.
- Explicit protocol, producer generation, freshness and unavailable outcomes; provider identity,
  model, context, activity and uptime retain unknown values rather than inventing defaults.

### Fixed

- Bound observation subprocess duration/output and transcript metadata cache memory; invalidate
  metadata on file replacement and rotation. Monitoring also works in boot-service locales.
## [0.39.7] — 2026-08-27

flush large JSON output before exit
## [0.39.6] — 2026-08-27

expose the external thread inventory
## [0.39.5] — 2026-08-26

connect Codex App threads to shared chat
## [0.39.4] — 2026-08-26

release interrupted Codex chat pickups
## [0.39.3] — 2026-08-26

enable managed Codex chat

### Added

- **Managed Codex sessions can participate in ccmux chat.** Local, cross-provider, and fleet-address
  messages preserve the exact provider, machine, session, and thread identity already carried by the
  v2 envelope and reply route.

### Fixed

- **Interrupted Codex turns release their durable pickup.** A terminal abort record now closes the
  injected turn after the normal settle boundary, without replaying its message, so later queued
  mail can continue after an interrupted or restarted recipient.
- **Codex delivery is fail-closed around live terminal state.** Structured pane inspection separates
  idle, working, queued input, partial input, approval/menu, startup, reconnect, and unknown frames.
  The final inspection and paste+submit are protected from concurrent client input.
- **`wait` follows the injected Codex turn, not an older answer.** An immutable message ID, durable
  pickup barrier, pane submission receipt, and transcript boundary prevent premature completion and
  duplicate delivery across daemon or session restart.
## [0.39.2] — 2026-08-26

retain anonymous turns across spinner frames

### Fixed

- **Marker-free Claude turns stay stable even when `turnStartedAt` is unavailable.** The 0.39.1
  resolver protected only lifecycle=`working`; a prematurely closed or hook-less turn still became
  idle on every blank spinner frame. `indeterminate` now consumes bounded turn evidence in that
  branch too, while a real Stop and structural idle remain immediate and expired evidence returns
  to idle instead of creating permanent work.
## [0.39.1] — 2026-08-26

keep active turns stable across spinner frames

### Fixed

- **A Claude spinner animation frame no longer makes an active turn flicker to `idle`.** Pane scans
  now distinguish a positive working marker from an indeterminate frame, and `list`/`fleet` resolve
  negative frames with the same lifecycle-scoped, bounded turn evidence used by `wait`, deferred
  delivery and daemon observation. Stop still closes voluntarily finished turns immediately;
  interrupted turns still close after bounded silence instead of staying `working` forever.
## [0.39.0] — 2026-08-26

a held message no longer looks the same as a quiet peer

### Fixed

- **A held message no longer looks the same as a quiet peer.** Delivery holds when the recipient's
  composer has unsent text in it — correct, since appending to a half-written line would send
  somebody's draft — but the hold was unbounded and told nobody. Measured on this fleet: a message
  held eleven hours behind a parked composer, three more sent on top of it, and a working session
  spent reporting "waiting for a reply" about a peer that had nothing to reply to. The send
  succeeded, so from the sending side there was nothing to see.
- **`ccmux wait` now names the hold.** It runs on the machine that holds the message, so the answer
  was a file away the whole time; saying only "waiting on undelivered mail" threw it away, and a
  caller reads that as "the peer is thinking".
- **The composer hold no longer claims a human is typing *right now*.** True at three seconds and a
  lie at eleven hours — and the lie is the costly direction, because it reads as transient and sends
  nobody to look. It says what it actually detects: unsent text in the composer.
- **A hold past ten minutes says how long it has lasted.** One sentence used to answer both "wait a
  moment" and "this is not moving"; only one of them is worth acting on. The daemon now remembers
  when it FIRST held a given message, rather than only that it held it a moment ago.
- **`ccmux doctor` reports mail held past that point.** A stall is invisible from the sending side by
  construction — the send succeeded and everything after happens on the receiving machine — so it
  has to be findable there, or it is findable nowhere.
## [0.38.0] — 2026-08-26

carry each session's declared directory through the fleet fan-out

### Fixed

- **`fleet --json` no longer drops each session's declared directory.** `list --json` has always
  reported it; the fleet layer's tolerant remote schema and local projection rebuilt session rows
  without it, so a fleet consumer got an address and a provider and nothing that said WHERE a session
  works. The only thing left to join a session to a project was its NAME — chosen by a person,
  usually the project's, and precisely the guess that has misrouted work on this fleet before.
- Transported, never interpreted. A consumer matching by longest same-host path prefix needs the
  string as the owner declared it: shortening it, resolving a symlink or trimming a trailing slash
  would each silently change which project it matches. ccmux knows what a session declared; what that
  directory MEANS belongs to whoever keeps the catalogue.
- `null` from a peer whose `list --json` predates the field, and that peer's other sessions still
  arrive — one missing field must never cost a machine.
## [0.37.0] — 2026-08-26

the chat log as a resumable feed, with a cursor that is a position

### Added

- **`ccmux chat log --follow` — the chat log as a resumable feed.** The snapshot answers "what is
  there now", which a live surface has to ask again and again: every poll re-serialises history the
  consumer already holds, and one long message pushes that single document past a transport's cap,
  where it stops being partly readable and becomes unreadable — a cut document has no last brace.
  Bounded records cannot fail that way.
- **The cursor is a POSITION, not a timestamp** — `<generation>.<ledger>.<outbox>`. Rows carry the
  clock of the machine that minted the message, so many share a second and a corrected clock can put
  a later record behind an earlier one; a time cursor would replay what a consumer has or, silently,
  skip what it has not. Both sources are append-only, so record N is record N forever. A cursor from
  a retired record generation is refused rather than reinterpreted, because that is the one event
  that moves positions.
- **Every record is bounded to one transport chunk (32 KiB), and an oversized body is REPLACED
  rather than cut** — with a sentence naming its real size. Route, time and position all survive, so
  the cursor still advances and nothing after it is lost.
- `--framed` wraps each frame for a transport that resumes, and `STITCHWIRE_STREAM_CURSOR` is read
  on reopen — the same contract the session event feed already speaks. An unusable cursor is refused
  loudly from either source: ignoring it and starting from "now" is the failure with no symptom.
- One strict frame schema covers rows and machine availability, so "nothing happened there" stays
  distinguishable from "we could not look".

### Fixed

- **`chat log --fleet` asked only ssh peers.** A machine reachable only over the wire was not shown
  as unreachable — it was absent, which reads as a machine where nothing has ever happened. Same
  resolver as everything else now.
- **A peer answer cut by the transport is named as cut, not blamed on an old build.** Both produce
  the same parse failure and are nothing alike: one is fixed by asking for fewer rows, the other by
  upgrading a machine. This snapshot serialises whole message bodies, so being cut is the failure
  that actually happens, and "older ccmux?" sent the reader to the wrong machine entirely.
## [0.36.2] — 2026-08-25

a dead lock holder no longer outlasts every waiter

### Fixed

- **A dead lock holder no longer outlasts every waiter.** The session registry lock reaped an
  abandoned lock only after 30 seconds of staleness, while a waiter gave up after 10 — so the reap
  was unreachable for anyone who arrived before the lock went stale. Measured: a lock abandoned one
  second earlier by a process that had died wedged the next caller for the full 10 seconds and then
  failed, even though `process.kill(pid, 0)` would have called that owner dead immediately. The same
  probe now succeeds in 25ms.
- **Death is proven by the pid, and age is asked exactly one question.** A dead owner's lock is
  reapable the instant it is seen, at any age. Age now decides only whether a directory with *no
  readable owner* is a claim in flight — there are two syscalls between creating the directory and
  writing the owner file — or the wreck of one. A live owner is still never taken, however old the
  lock is.
- **A creator that fails to claim its own directory clears it immediately** instead of leaving a
  lock nobody owns and nothing will come for. That shape blocked every caller, including the one
  that made it, over a failure already known about.
- The timeout now says what was in the way — the pid of a live holder, or that no owner was
  recorded. A bare "timed out" sends a reader looking for contention that may not exist; this
  happened, and the message was the reason it could not be diagnosed.
## [0.36.1] — 2026-08-25

below 1.0.0 the minor bump IS the breaking one

### Fixed

- **`behind` now treats the leftmost non-zero position as the breaking axis.** It read the version
  positions literally, which makes `major` unreachable for the whole pre-1.0 life of a project and
  files every breaking jump under `minor` — 0.23 against 0.63 is forty breaking releases reported as
  a moderate one. Below 1.0.0 the minor position is the breaking one; that is what `^0.23.0` encodes,
  and it is where this project and its neighbours live. A compatible bump stays `patch`, because
  overstating it in the other direction is no better. Caught in review by the consumer that draws
  this field: a dashboard colours by the word, and the reader acts on the colour.
## [0.36.0] — 2026-08-25

a machine says how far behind the current release it is

### Added

- **A machine says how far behind the current release it is.** `ccmux fleet` could show which version
  each machine runs and nothing about whether that was the right one — the other half came from a
  person reading the releases page and comparing by eye. The supervisor already fetched the release
  manifest on every tick, compared it, acted on it, and then discarded the answer; it is recorded now
  and reported in `list --json` and `fleet --json`.
- Each machine reports facts about **itself**: `current`, the newest release it managed to read,
  `latestAt` (stamped into the manifest at publish time, so lag can be read in days rather than in
  version components), when it last tried, and whether that attempt worked.
- **The yardstick is one per answer, and it is not the machine's own memory.** `fleet` takes the best
  release any machine could report and measures every machine against it. Judging a disconnected box
  by what it last managed to read reports it as *less* behind than it is — sometimes as up to date —
  and that error points in the reassuring direction, in exactly the case someone is checking because
  something looks wrong. Caught in review by the consumer this was designed with.
- `behind` is classified as `patch` / `minor` / `major` by the side that owns the version scheme, so
  consumers do not each reimplement a semver comparison and then disagree about the same machine. A
  machine ahead of the release is not behind — that is a development checkout.
- Three states stay distinguishable: behind, current, and **nobody has been able to check**. The last
  must never be drawn as current, which is what it would look like if "unknown" and "up to date" were
  the same value.
## [0.35.0] — 2026-08-25

an owner outside the fleet has an address, and the hop through a person is written down

### Added

- **An owner outside the fleet has an address: `owner/<name>`.** A component owner can work as an
  agent in another product entirely, and ccmux is not that product's transport. One hop through a
  person is cheaper than integrating with someone else's product — what was missing is that the hop
  was *unwritten*: no record, no reply address, and no way to ask what had not come back. And with
  nobody to address, people addressed the project, which is usually also a session name, so the
  message resolved and landed on a neighbour.
- Declared in `machine.json` under `externals`, as prose: a person is the route, and anything more
  structured would be a promise ccmux cannot keep. An undeclared name is refused rather than
  invented, and the address carries no colon so it can never be read as `<machine>:<session>`.
- The letter is appended to the ledger like any other, with a true `to`. Automatic delivery
  **refuses and names the route** instead of half-succeeding — a sender that believes it reached the
  owner is the exact failure this address removes. The Telegram mirror renders it as an errand: where
  to take it, and the one command that brings the answer back.
- **Awaiting a reply by DEFAULT**, not a flag the sender sets. A flag you have to remember is wrong
  within a week, and waiting for an answer is the norm here rather than the exception. `ccmux inbox`
  lists what has gone out and not come back, with its age and sender.
- **`ccmux relay owner/<name> "<their answer>"`** closes the loop: recorded as a relay — *on behalf
  of* that owner, never as that party speaking, since ccmux cannot authenticate them — delivered to
  whoever wrote, and the letter stops waiting. Answers are counted per letter and per task, so two
  errands want two answers and one reply cannot close both.
## [0.34.0] — 2026-08-25

the ledger survives a record it cannot read, without moving the others

### Fixed

- **A chat record written by a newer ccmux no longer takes down the whole ledger.** `loadLedger`
  threw on the first record it could not parse, and `msg`, `inbox`, delivery and the TUI all read the
  ledger through it — so a single record of an unfamiliar shape meant no chat at all on any machine
  that had not upgraded yet. A fleet always has that window: rollout takes minutes and a rollback is
  a legitimate operation. Such a record is now stepped over.
- **The skipped record keeps its POSITION.** Delivery cursors are positions in that array, so
  dropping a record would shift every later index and hand a cursor written by one build to a
  different message under another — mail re-delivered, or skipped and never seen. A hole costs a null
  check; a shift costs mail.
- "Written by something newer" and "malformed" are now decided apart rather than assumed alike. A
  record still carrying everything this generation requires is an extension and is skipped; one
  missing that core is malformed and still fails loudly, because a writer bug that goes quiet is a
  bug nobody fixes. A line that is not JSON is damage, not skew, and still stops the read — as does a
  record from an *older* generation, which needs a person to migrate it.
- `ccmux doctor` and `ccmux inbox` report how many records this build cannot read. An append-only
  history that quietly looks shorter than it is has stopped being one.
## [0.33.0] — 2026-08-25

address a session by what it does, not by what it is called

### Added

- **`ccmux role` — a session declares what it is FOR, and an address can select on it.** A name is
  chosen once and it is usually the project's; a project has several sessions and only one owns any
  given decision. So an address picked from a project name resolves, delivers and exits zero — onto
  the neighbour. Nothing reports a problem, and that is what makes it expensive: measured on a fleet,
  an hour spent believing a report had reached the owner of a contract while it sat in a session that
  does not decide contracts. It is the same class the machine label removed, one level in.
- `ccmux msg <machine>:@<role>` addresses by role. `@` is a separate namespace rather than
  decoration: without a sigil a role and a session name compete for one space, and an address that is
  both would have to pick — which is the bug.
- **A role matching two sessions refuses the address**, and the refusal carries what a reader needs
  to choose: each candidate's directory, what it last said, and the exact address to retry with. The
  refusal is the mechanism — a role merely printed somewhere is documentation, and documentation is
  not read at the moment an address is chosen.
- The role applies at once and never marks a session for restart. That is a requirement, not a
  convenience: a second name that costs something to correct is one people put off correcting, and
  within a week it lies while being trusted — worse than having no role at all.
- Shown on the address line in `ccmux fleet` (the line people copy from) and in `list --json` /
  `fleet --json`, including for remote machines. A remote role resolves against the same `list --json`
  answer the peer identity comes from, so a session cannot be selected by a role it held one call ago.
## [0.32.0] — 2026-08-25

a pane is a written fact, not a glance

### Fixed

- **`ccmux wait` no longer answers "done" about a session that is mid-work.** It is the fleet's only
  correct "is the peer done" test, and a false yes is expensive: the documented next step is
  `transcript --last-message`, which then hands back what was said BEFORE the tool calls that had
  not finished, as if it were the answer. The cause is that a turn is judged over by SILENCE, and a
  session four minutes into a tool call is legitimately silent — it writes nothing to the transcript
  while its pane is plainly working.
- **A pane is now a written fact, not a glance.** A transcript has an mtime, so any process can ask
  how long a session has been quiet; a spinner is instantaneous, so looking once tells you about
  this moment and nothing before it — and `ccmux wait` is a fresh process on every call, so no
  memory of its own can cover its first look. The supervisor, which looks at every pane every couple
  of seconds anyway, records what it saw in `<stateDir>/pane-activity.json`, and everything that
  judges silence reads it. A stale or missing record only ever degrades a reader to the
  transcript-only answer it used to give, never to a more confident one.
- Deferred chat delivery gets the same correction: it waits for a turn boundary, and a false
  "between turns" spent that wait for nothing and landed the message inside the turn it was meant to
  follow.
- The observation pass now runs whether or not the event feed is switched on, with the switch
  applied per session to what gets appended. Repairing an abandoned `working` stamp and recording a
  pane are not a feature anybody subscribed to — `list`, the TUI, `wait` and chat delivery read them
  regardless — so gating them on a publication toggle let switching off a feed quietly weaken
  delivery.
## [0.31.1] — 2026-08-25

a spinner is activity, so a long tool call is not a dead turn

### Fixed

- **A live turn is no longer mistaken for a dead one while a tool is running.** The evidence a turn
  is over is silence — and a session four minutes into a build is legitimately silent, writing
  nothing to the transcript while its pane is the only thing still saying otherwise. Sample that
  pane in the instant between a tool finishing and its result being written and there is no spinner
  either. Measured on the fleet: a live turn closed and announced as interrupted 29 seconds after
  its own pane had been working, and a pane seen working on one observation pass read still on the
  very next one, two seconds later. A turning spinner now counts as activity beside a transcript
  write, so the proof window runs from the later of the two.
- The first look at a session now acts on nothing: it has no baseline to be a diff against, so it
  cannot tell a turn that died an hour ago from one whose pane it sampled at the wrong instant. The
  pass two seconds later is where an inherited orphan gets closed.
## [0.31.0] — 2026-08-25

the snapshot says when the current turn began

### Added

- **`turnStartedAt` in `list --json` and `fleet --json` — when the turn that is running now began.**
  A consumer drawing live state wants a growing counter beside `working`, and the feed alone cannot
  supply one: a transition is only heard by whoever was listening at the time, and a consumer
  restarting is routine rather than an emergency. After a restart it saw `working` and could not tell
  three seconds from forty minutes. It is an absolute instant, never an elapsed count — elapsed is
  only true at the moment it is produced, so a snapshot that crossed a network and sat in a cache is
  short by exactly the delivery time. Null when the session is not in a turn, or is in one whose
  start nobody recorded; `state` tells those two apart. Reported for remote machines as well, from
  their own `list --json` — a peer on an older build simply omits it and it reads as null.

### Fixed

- **A `working` stamp no longer outlives its turn.** `Stop` fires only when a turn ends
  *voluntarily*, so an interrupted turn — or one whose hook did not run — left the lifecycle stamp
  saying `working` with nothing inside the session able to correct it. Measured on a live machine:
  four of seven `working` stamps were of turns already over, the oldest by two and a half days. The
  supervisor now closes what the hook abandoned, once it can prove the turn is over by the same
  standard chat delivery uses to decide it is safe to type into a session.
- That one stamp was costing three separate lies: the abandoned turn never got a `turn-end`, so a
  consumer showed the session working forever; the **next** turn never got a `turn-start`, because a
  prompt arriving under a `working` stamp joins the turn already running instead of beginning one;
  and that next turn inherited the old instant as its start. All three close together.
- **The duration of a turn closed by observation now runs to when the transcript stopped, not to
  when we noticed.** Proof of a dead turn only arrives after a stretch of silence, so the moment we
  can say so is always later than the ending. Measuring to `now` inflated every such turn by at least
  a minute, and one nobody looked at for an hour by an hour.
- A turn already over the first time the supervisor looks is closed **silently**: its ending was
  never witnessed, and dating it to the instant a daemon happened to start would publish a two-day-old
  event as news. The stamp is repaired either way.
- A late `Stop` on a turn the supervisor already closed says nothing, instead of announcing the same
  ending a second time without a duration.
## [0.30.3] — 2026-08-25

a turn begins with a transition, not with a message

### Fixed

- **A prompt arriving inside a running turn no longer starts a new one, and no longer shortens it.**
  Found by another consumer reading the live feed: three `turn-start` events 50ms apart with no end
  between them. A delivered chat message, a background watcher's notification or a second question
  typed after the first all arrive as prompts, and none of them begins a turn.
- The same write also moved the turn's start instant forward on every prompt, so `turn-end` reported
  the time since the last message instead of the length of the work — a lie about the one number this
  feed exists to publish, and a convincing one: plausible on its face, and under-reporting more the
  busier a session is. The start instant is now kept for the turn it belongs to.
## [0.30.2] — 2026-08-25

an abandoned turn is announced once, not once per observation pass

### Fixed

- **An abandoned turn is announced once, not once per observation pass.** Found by the first live
  look at the feed on the fleet: one interrupted turn produced three events in six minutes with a
  growing duration. The "this turn was interrupted" signal is derived from how long the transcript
  has been quiet, so it drops to false the moment the file stirs and rises again after the next
  silence — deduping on "was it true last pass" therefore re-announced the same turn. It now dedupes
  on the identity of the turn, which does not flicker. For a consumer that speaks an event out loud,
  this was three announcements of one thing.
## [0.30.1] — 2026-08-25

a reopened event stream resumes where the reader left off

### Fixed

- **A reopened `--follow` now resumes where the reader left off.** A feed with no natural end is
  capped by a deadline, so a transport reopens it on a schedule and returns the cursor through the
  producer's environment — not its arguments, since the profile refuses caller-supplied ones.
  `ccmux events` did not read that variable, so every reopen silently restarted from "now": the
  stream opened, frames flowed, and the gap simply did not exist for the consumer. No error, once
  every fifteen minutes. An explicit `--since` still wins over the variable, and an unparseable
  cursor fails loudly rather than degrading back into that silence.
## [0.30.0] — 2026-08-25

sessions publish what happened, and the wire's answer is read in full

### Fixed

- **Cross-machine mail to a wire-only peer could be thrown away.** The outbox drain pass read the ssh
  fleet map directly, and a machine reachable only over the wire has no alias in it — so every retry
  to it found "no route", marked the envelope delivered and dropped it, silently. Measured on a live
  fleet: both servers reach the laptop over the wire and have no ssh alias for it at all, which is
  the direction the wire was added for. Retries now resolve the route the same way a send does; the
  only settle case left is a target in neither map, and it is logged.
- A refusal that will never change is no longer retried for an hour and no longer described as
  "queued, retried automatically". The wire distinguishes a temporary `capacity` refusal from a
  permanent `policy`/`request` one; ccmux reads that distinction, settles the permanent kind and says
  plainly that waiting will not deliver it. Promising a recovery that cannot come is what stops
  anyone from looking at the thing that needs fixing.
- The local agent's contract version is compared rather than ignored, so an agent speaking a door API
  this build does not know is named as exactly that instead of surfacing as an unreadable answer.

### Added

- **A session event feed.** `ccmux events [--follow] [--since <iso>] [--session <name>] [--json]`
  publishes what HAPPENED to sessions — turn boundaries with duration, waiting at a blocking menu and
  leaving one, stop and blocked — instead of making every outside surface poll `list --json` for what
  is true now. Polling could not answer the question anyway: a turn that starts and ends between two
  polls leaves no trace, and duration is not recoverable from two snapshots.
- Two writers, because one cannot see everything: the turn hook records exact voluntary boundaries
  (duration measured from the status the previous hook left), and the daemon's observation pass
  records what no hook can — a menu the agent is stuck at, a turn that was interrupted (`Stop` never
  fires for those), and a session that stopped or blocked.
- Nothing is executed on an event. The turn hook is what the agent waits on to finish a turn, so a
  consumer's command there would put foreign code on the critical path of every turn on the machine.
  An append is one syscall; reacting is the reader's job.
- `--framed` wraps each line as `{ data, cursor }` for a transport that resumes a broken stream from
  where the reader got to. Kept separate from `--json`, which stays the clean stream of events a
  person reads: wrapping by default would make the common case pay for a transport's contract.
- Delivery is at-least-once by design — `--since` is a time, not a byte offset, because an offset is
  meaningless once the feed rotates — so every event carries an `id` for consumers to dedupe on.
  Records parse leniently: a field added by a newer build cannot make the feed unreadable on an older
  machine. `sessionEvents` (machine) and `eventsEnabled` (session) switch it off; both default on.
## [0.29.0] — 2026-08-25

the launch stamp sees the rules, MCP and environment that argv never showed

### Added

- The `RESTART` column now sees what an agent reads at startup from OUTSIDE argv: its global rule set
  (with imports expanded for this machine), its MCP configuration, and the env files the supervisor's
  runtime loads from the session's own directory — reported as `rules`, `mcp` and `env`. Previously
  the column answered "a restart would change nothing" while knowing a quarter of the inputs; a
  fleet-wide rule change left every session running yesterday's rules behind a clean column, and the
  only remedy was bouncing two dozen sessions blind. Providers declare their own external inputs, so
  a new agent brings its own file locations and the core learns none of them.
- Digests are deliberately narrow: the `mcpServers` table rather than the file around it, global
  rules rather than project rules, and never the agent's settings file. Those files are rewritten by
  the agents themselves several times an hour, and a column that lights up hourly stops being read.
  Reads are cached by mtime (measured ~1 ms cold, ~0.07 ms warm per session).
- `ccmux doctor` reports where a session's environment came from — which env files the runtime mixed
  in, how many variables, their NAMES (never values), and whether those files changed since launch.
  On the first fleet it was run against, 5 of 14 sessions were carrying project variables nobody had
  declared, API keys among them.
- `ccmux restart --all` now reports its result. The sweep is the one command whose caller is dead
  when it finishes — it restarts the calling session last — so the outcome had nobody to return to
  and an agent that swept the fleet sat silent until a human asked. The report is a recorded chat
  envelope, not a revival of `restart --then` (removed in 0.12.0 for having no sender, no reply
  address and no ledger entry): it goes to the calling session, or to the owner when the sweep ran
  from a shell — and a caller that did not come back is named out loud rather than lost with it.

- A session's environment is now a declared recipe (`ccmux env-file <name> <path>`, `ccmux new
  --env-file`) instead of whatever the supervisor inherited. Previously the runtime loaded the session
  directory's `.env` into the supervisor and the launcher copied it into the agent, so a project's
  secrets reached the agent and every process it spawns — MCP servers, shell tools, subagents —
  undeclared and invisible. Two mechanisms hold the new behaviour because they fail in different
  places: the pane re-exec carries `--no-env-file`, and the recipe subtracts those names again when
  building the agent's environment (a `bun build --compile` binary never sees the flag, and nothing
  else substitutes for it there). `CCMUX_*` names are refused from an env file and reported — a
  session grants a project variables, it does not let a project reconfigure its supervisor.
- `ccmux env-file --adopt` migrates sessions that are still running on an undeclared file, and
  `ccmux doctor` lists exactly those until none are left, so "the migration is done" is a state you
  can read rather than believe. A declared file that is missing costs a variable, never the session;
  `list` prints the missing path.

### Fixed

- The `reply:` command in an incoming chat tag is now computed by the same resolver `msg` delivers
  with, so a sender reachable over the stitchwire transport is answered on the wire instead of being
  declared unreachable. The hint previously consulted only the ssh fleet map: a machine with a live
  wire route to the sender was told "no route back", followed that prescriptive instruction, and
  answered the owner while peer-to-peer delivery was working the same minute.
- When a reply genuinely cannot be routed, the tag now names the resolver's reason — unknown machine,
  no transport configured, local stitchwire agent down — instead of a bare verdict with nothing to
  check. The local agent socket is checked by existence only, never probed, so a healthy-but-busy
  agent can never be reported as unreachable.
## [0.28.0] — 2026-08-21

anonymous remote messages now expose their missing return route

### Fixed

- A direct remote `ccmux msg` launched beneath SSH or Stitchwire without managed session identity
  still delivers as the honest `cli` principal, but now warns on stderr that the recipient has no
  route back to the originating agent. Local human CLI sends and authenticated managed senders stay
  quiet; the distinction comes from verified process ancestry rather than environment or address
  guesses.
## [0.27.0] — 2026-08-19

a dead agent socket no longer travels into a session that outlives its login

a dead agent socket no longer travels into a session that outlives its login

A supervised session outlives the login that created it; `SSH_AUTH_SOCK` does not. tmux copies that
variable from whichever client creates a session, so restarting a fleet over ssh with agent forwarding
hands every session a socket that dies with the caller. One box was found running five sessions
carrying sockets from two long-closed logins, every cross-machine send from them failing.

The failure is a liar twice over: a dead socket produces either a hang to timeout or an instant
`Permission denied`, so response time distinguishes nothing, and both read as "this machine has no
access" when in fact ssh never got as far as trying anything else.

Sessions now launch without those variables **when the socket is already gone**, logged. A live socket
is never removed: whether a machine can reach its peers without one is that fleet's ssh configuration,
not something ccmux may assume, and taking away a working credential to enforce a theory is worse than
the problem.

`peer-routing.md` and the README now document how to reach a peer and how to check a route —
including why the obvious check lies. `IdentityAgent` in `ssh_config` overrides `SSH_AUTH_SOCK` and
multiplexing reuses somebody else's authenticated connection, so a route check needs
`-o IdentityAgent=none -o ControlPath=none -o BatchMode=yes`. Unsetting the environment variable is
not a substitute; it answers according to whether the configured socket is alive that minute.
## [0.26.0] — 2026-08-19

a failed hop is reported as a queued message, not as a lost one

a failed hop is reported as a queued message, not as a lost one

Two separate sessions arrived at the owner on the same day with the same non-existent problem: "the
transport to the peer is down, we need your laptop." Neither invented it.

A cross-machine send that lost its hop printed `transport failed (ssh unreachable, timed out, or no
agent forwarding) — nothing was sent`. Both halves were false. The envelope is written to the outbox
*before* the hop, and the drain loop retries it for an hour — five such messages landed on retry on
one machine in a single day, none lost. And the cause was a default string, printed even when the
transport reported nothing: it is what pointed both sessions at the owner's forwarded key.

The send path no longer borrows the generic relay wording. It says the message is queued, that retry
is automatic, how long the window is, and that nothing is required of the reader. A cause appears
only when one was actually reported — in `relay` too. A diagnostic that guesses is worse than one
that stays silent, because the guess gets believed and acted on.

Also documented in `peer-routing.md` as a rule, not a note: never name a cause the transport did not
report, and never describe a queued message as a lost one.
## [0.25.0] — 2026-08-19

the Telegram mirror reads like a message, not like an address

the Telegram mirror reads like a message, not like an address

One mirrored header ran 130 characters, of which 72 were two thread uuids and 26 were `ccmux/claude@`
written twice. The owner reads this on a phone and could not read it.

The long form was deliberate: both endpoints were written as full fleet addresses so every line could
be copied into `ccmux msg`. That reasoning does not survive the medium. The mirror is one-way — there
is nothing to reply to from Telegram, so the address is never copied anywhere; and a managed session
pins one thread when it is created, so the uuid separates nothing a reader needs. A machine-facing
format was serving a human-facing channel, and the reader who could not argue back lost.

The route is now `machine:session` on both sides — 28 characters, still unambiguous, because that is
exactly what fleet addressing guarantees. The machine stays: the same session name commonly exists on
two boxes, so dropping the uuid is safe and dropping the machine would not be. Mail to the owner
collapses to `📩 [machine:session → you]`. The exact address keeps its place in the pane tag, where an
agent really does copy it to answer.
## [0.24.0] — 2026-08-19

a removed command names its replacement instead of a usage line

a removed command names its replacement instead of showing a usage line

`restart --then "<note>"` was removed in 0.12.0 — deliberately: a hand-off has to be recorded, and a
note carried by a lifecycle flag has no sender, no reply address and no entry in the ledger. What was
not thought through is what the removal left behind. Every unexpected token fell through to the same
generic `usage: ccmux restart <name>` line, which cannot tell "you typed it wrong" apart from "this
no longer exists, use that".

A session on a server hit exactly that. It had been told to use the flag by a rule file in another
repository, written when the flag existed and never updated since. It read the refusal as a VERSION
problem — "this build doesn't support it" — and went off to build a workaround, then put a task on
its owner's desk that did not exist. The reasoning error was its own: the tool is reality and a rule
is only somebody's past intention. But the misleading answer was ours, and we had taught that flag
ourselves through the injected prompt for months.

Retired public syntax is now a table (verb, token, version, replacement, reason) checked at the
dispatcher, before any command parses its arguments — so a new command cannot forget it and the next
removal is one row. The notice states the version that removed it, the command to run instead, why it
went, and that a rule still teaching it is what is out of date. Matching is verb-scoped and
whole-token, so a chat body discussing the flag passes straight through.
## [0.23.0] — 2026-08-18

stitchwire transport: the fleet map is no longer one-directional

the fleet map is no longer one-directional: a server can address the laptop

The fleet had a one-way map by construction. The laptop reached every server; no server ever
reached the laptop — not a missing config line, but the absence of anything to reach: no stable
address, no open port, and a machine that changes networks daily. An agent on a server could finish
a delegated job perfectly and then had no route to hand the result back (the 2026-08-05 live check,
recorded in the return-channel note).

ccmux now carries a second transport. [stitchwire](https://github.com/max-listov/stitchwire) has
every machine dial OUT to a broker and keep that connection, so the direction of the TCP link and
the direction of a call are unrelated — a laptop behind NAT is as addressable as a server with a
public IP, while no node listens on a port and no node holds a credential to another node.

- `wire.peers` in machine.json lists machines reached through the local stitchwire agent instead of
  ssh — per direction, so the transport is adoptable one route at a time and "which path did that
  call take" stays answerable.
- `runPeer`/`peersOf` are the single place deciding how a remote call travels; `fleet`, `doctor`,
  `msg` and command forwarding all route through them unchanged.
- `routeFor` accepts a machine with no ssh alias at all — the laptop's case.
- `doctor` verifies a wire peer really reports the rcPrefix it is mapped to, and separately that
  the local agent socket exists (without it every wire peer would read as unreachable, sending the
  reader to debug the wrong machine).
- Transport failures now carry the real reason (`denied`, `offline`, `timeout`) instead of the
  one-size ssh sentence: a policy refusal must not send the reader looking for a network fault.
- Admission stays hard: chat receive requires descending from an authenticated remote transport —
  sshd, or the stitchwire agent (proved by process-tree walk; `stitchwire call` deliberately does
  NOT confer admission, so a local process cannot launder itself into delivery through the CLI).
## [0.22.0] — 2026-08-17

a session waiting on a human is no longer reported as idle

a session waiting on a human is no longer reported as idle

A fleet-wide restart brought six of twelve sessions back sitting at Claude's folder-trust dialog,
unable to do anything. `ccmux list` showed all six as `idle`. The owner found out by opening a
terminal and looking.

The knowledge was already in the codebase. `atInteractiveMenu` positively identifies "a blocking
menu is up" and was used by exactly one caller — chat delivery, which correctly refused to type into
a menu it would have answered by accident. The status column never asked. Same shape as the chat
resolver and the launch-env stamp before it: a fact established in one path and not consulted in the
neighbouring one.

The second half is that ccmux *already answers* menus — `resumePickerAnswer` existed precisely
because "a daemon-healed resume has nobody to answer it" — but was nailed to one menu matched by two
exact strings. Every other menu stranded the session silently.

Blocking menus are now a table with a policy per entry, and the watcher runs on every launch rather
than only on a resume (a fresh session in an unseen directory is exactly the case that stranded).
`machine.json` gains `trustPrompt`: `folder` (default) answers the plain trust question, `declared`
also accepts folders that pre-approve tool permissions in their own `.claude/settings.local.json`,
`off` answers neither. The split is the point — registering a session pointing at a directory is
already the owner's declaration about that directory, while permissions a checked-in file declares
are a decision nobody has made, and granting those unread is not the supervisor's call to make.

Whatever the policy answers, an unanswered menu is now visible rather than silent: `list` shows
`prompt` instead of `idle`, the TUI names the question, and `doctor` lists every session stranded on
one. A menu we do not recognise reports as an unrecognised choice — still not idle.
## [0.21.0] — 2026-08-17

a lost conversation now has a way out that is not demolition

a lost conversation now has a way out that is not demolition

A disk cleanup took one session's transcript with it. The guard did its job: a session that has run
before, whose conversation is missing, refuses to start a NEW one under the same uuid — otherwise the
session comes back wearing its old name with none of its memory, and nobody is told.

Then the guard went quiet. It named one exit — put the conversation back and `start` — and said
nothing about the case where the file is gone for good, which is the common one. That left `rm` +
`new` as the only path: demolish the registry entry and rebuild it. This session got away with it,
carrying nothing but a name and a directory. A session with a permission mode, a chat override or
prompt modules would have lost all of them — not because they were wrong, but because an unrelated
file disappeared next door.

`ccmux renew <name>` gives a session a fresh conversation and keeps everything else. It refuses while
the conversation is still there, naming the file it would orphan and offering `restart` instead;
`--force` is for abandoning one deliberately. The block message now names both exits, because the two
cases need opposite actions and the reader already knows which one they are in.

Also: `rm` clears the block belonging to the name it unregisters. A verdict describes a session, and
once the session is gone it describes nobody — a later session of the same name inheriting it was
prevented only by generation and uuid failing to match, which is luck rather than design.
## [0.20.0] — 2026-08-17

the tool no longer lives in a directory that invites its own deletion

the tool no longer lives in a directory that invites its own deletion

`~/.cache/ccmux/` was wiped on a server — a legitimate act against a directory whose contract says
so. The registry, chat and config survived exactly as the layout intended. The code did not, and the
comment explaining why that was fine turned out to be the defect: "deleting this costs exactly one
`ccmux update`" is false when the cache holds the tool, because that command *is* the deleted file
and the boot unit's ExecStart points at it too. The rollback copy the boot guard needs lived there
as well, so the safety net went with the thing it protects.

What made it worse than an outage was that it did not look like one. A running daemon serves from
memory, so eleven sessions kept healing and chatting while the machine had quietly become unable to
ever start again. Version equality read as health for as long as the process happened to live.

The bundle now sits in the durable data root; `staged/` and `releases/` stay in the cache, where a
build or a download genuinely rebuilds them without the tool being intact. Installed machines move
themselves on first start of the new code and rewrite their boot unit and PATH shim without bouncing
a healthy daemon. The old copy is left where it was on purpose: launchd serves the definition it
loaded until the job is re-bootstrapped, so deleting the path it still believes in would open a
window where a daemon that died could not return. `install.sh` clears it once the machine is
fully converged. Update no longer decides on version alone: a bundle missing from disk is restored
whatever the versions say, so the daemon repairs this on its own tick. `doctor` reports a launch path
that leads nowhere, before anyone types a command that fails.

install.sh becomes the repair command, not just the install command

Fixing the machine above meant doing it by hand, because the installer could not be pointed at a
working machine: `--rc-prefix` had a default, so a repair could silently rename the machine — and a
machine's prefix is its fleet identity, carried by every session's Remote Control name.

Identity is now read rather than re-declared: an existing `machine.json` wins, a conflicting prefix
is refused with both names in the message, and `--force` remains for a rename someone actually
wants. `ccmux install` enforces this itself, so the guarantee does not depend on which caller is
used. Every step converges — bundle fetched only when the bytes differ, shim and unit written only
when they say the wrong thing, nothing restarted unless something changed — and a healthy machine
comes out reporting *nothing to do* with no files written.
## [0.19.0] — 2026-08-12

the transcript window is bounded in bytes, and the fleet view stops guessing

the transcript window is bounded in bytes, and the fleet view stops guessing

Reading "the last 2000 lines" of a transcript bounds nothing: cost is bytes, and how large one
record grows is the agent's business, not ours. On a box whose rollouts had reached 139KB per line,
that window meant 1.4GB read from a single file, and one inventory pass over 15GB of history pulled
6.7GB. The fleet view sat at `0 managed · 0 external` while it did — the managed fleet's own load is
a promise, and a blocked thread cannot deliver one, so neither number on screen was an answer.

Every tail read now carries a byte ceiling alongside the line cap, and the windows that exist to
find a fact — which model, how many tokens — widen only while that fact is still missing and stop
rather than walking back through the whole file. Correctness-critical readers (fork detection,
launch correlation) keep wide ceilings that bind only on a runaway file.

The external inventory is now off unless asked for. It is evidence gathered for a decision — adopt,
fork, take over — and its cost tracks accumulated history rather than fleet size, so a machine not
making that decision no longer pays for it on every launch. `x` toggles it live; `externalInventory`
in `machine.json` sets the machine's starting answer.

What the view knows about its own data is now distinct from what the data says: an empty list reads
`loading sessions…` until something answers, the header says `external off` when the section is
absent by choice and `external scanning…` while a pass runs, and discovery starts only after the
managed fleet has painted.
## [0.18.0] — 2026-08-11

inter-agent chat gains a machine default

inter-agent chat gains a machine default

Chat lived only on the session and was always born off, while the permission mode has had two levels
— a machine default plus a per-session override — all along. On a fleet that asymmetry means every
new session must be remembered, and a forgotten one is discovered when a peer does not answer.

`chatEnabled` is now a machine default too, with the session field becoming an optional override and
`ccmux chat default <name>` clearing it. The default still ships **off**: chat traffic is never
implicit. What changes is that the deliberate act happens once per machine instead of once per
session.

Eleven call sites read this flag — delivery, sending, receiving, the injected prompt, the Stop hook,
`inbox`, `doctor`, `wait`, `send`, the launch stamp. They now all go through one resolver, and a test
walks the source and fails if any of them reads the raw session field again: two levels folded
inline in one place and not another is a system where half of it believes chat is on, discovered
from a message that silently never arrives. That test found two sites missed on the first pass,
including the Stop hook that delivers deferred mail at end of turn.

The stamp hashes the RESOLVED value, so flipping the machine default marks the affected sessions in
the `RESTART` column — chat framing and the Stop hook are launch-time and would otherwise be
configured but not live. Existing registry rows carry an explicit value and therefore read as
overrides: they keep it until cleared, because "explicitly off" and "not set" are different things
and guessing between them is not ours to do.
## [0.17.0] — 2026-08-10

escalated modes under root take both locks, or neither

escalated modes under root: both locks, or neither

Escalated permission modes are blocked twice on a root daemon — ccmux downgrades them, and the agent
independently refuses to start as root at all. An earlier release lifted only ours, on the reasoning
that the guard was our policy to relax. It was released, deployed, and undone within the hour: the
agent's refusal was still there and every session on that box crash-looped.

The agent's own escape is an environment variable declaring the process sandboxed. So a machine that
sets `allowEscalatedUnderRoot` now gets **both** halves — no downgrade, and that variable passed at
launch. A test pins the two together, because half of this mechanism is not a degraded feature: it is
sessions that refuse to start.

Read the flag plainly before setting it. The variable asserts a sandbox, which on a bare server is
untrue; what the flag really says is *"I accept an agent acting as root here with nothing to approve
it"*. Legitimate for a box whose owner wants exactly that, expensive to enable by accident — hence
explicit, per machine, never a default. Undeclared machines keep the previous behaviour: `ccmux mode`
refuses the mode where it is set rather than storing something that can never take effect, `doctor`
names anything already configured that way, and the launcher still downgrades.

Turning it on changes the launch environment, so the stamp reports `env` and `list` asks for the
restart that applies it — the two mechanisms meet with no special-casing.
## [0.16.0] — 2026-08-10

a setting you cannot honour is refused where it is made

a setting you cannot honour is refused where it is made

Shipped, deployed, and undone within the hour — recorded here because the mistake is more useful
than the fix.

The previous release let a machine declare `allowEscalatedUnderRoot` and take `bypassPermissions`
under a root daemon, on the reasoning that the guard was ccmux policy and the owner should be able
to overrule it. It is not our policy: **the agent itself refuses the mode under root**
(`--dangerously-skip-permissions cannot be used with root/sudo privileges`). Lifting our guard did
not grant the capability — it put every session on that box into a crash loop. The cheap decisive
probe that would have shown this in seconds was skipped, because a guard was found in our own code
and the question felt answered.

The real defect was never the guard. It was that the system **accepted a setting it could not
honour**: `mode` stored the mode, the config kept it, and the launcher silently downgraded it — half
working, half not, with nothing said. So the refusal now happens where the decision is made:

- `ccmux mode` refuses an escalated mode under a root daemon, naming the **agent** as the reason (not
  ccmux — otherwise the next person goes looking for our switch, and there isn't one);
- `doctor` names anything already configured that way, since a config can be hand-edited;
- the launcher keeps downgrading as a last line of defence, because a session that will not start is
  strictly worse than one running guarded and reported.

Escalated modes on a server require a daemon running as a **non-root user**. That is the only path.
## [0.15.0] — 2026-08-10

escalated permission modes under root are the owner's declaration

escalated permission modes under root are the owner's declaration, not a refusal

Setting `bypassPermissions` on a root-daemon machine did nothing: the launcher downgraded it to
`auto` and said so nowhere. Measured on a live box — two sessions carried the escalated mode in the
registry while all nine running processes had `auto`.

The guard is right in substance. Under root, an escalated mode means the agent acts on the whole
host with nothing to approve it, and *a config edit alone* should never be what grants that. It was
wrong in form: it behaved as a veto, leaving the machine's owner no way to make the decision at all,
and never mentioning that their choice had been overruled.

A machine now declares it once, in writing — `allowEscalatedUnderRoot` — and gets exactly what it
asked for. Deleting the guard instead would have been shorter and wrong: every other root machine in
a fleet would inherit the escalation the moment one of them wanted it. The permission-flag route is
gated by the same declaration, since it is the same escalation by another name, and the decision
became a pure function so it is tested instead of depending on the running process's uid.
## [0.14.0] — 2026-08-10

two ways the supervisor knew something and said nothing

two ways the supervisor knew something and said nothing

**A capability handed out at launch is now part of the recipe.** Sending chat is authenticated by a
secret given to a session when it starts — deliberately through the environment, because a secret
must not be an argument. The launch stamp hashes argv, so it could not see it: every session started
before that capability existed kept RECEIVING while silently unable to SEND, and the RESTART column
said a restart would change nothing. One-way traffic is worse than a clean failure — from the
outside it looks like it works. The stamp now records the ccmux-controlled env var **names** (never
values: the secret rotates every launch, so hashing it would make every session permanently stale and
put a copy on disk) and reports `env`. A stamp written before the field existed stays *unknown*, not
stale — the same doctrine a missing stamp has always had.

That doctrine leaves a gap the stamp cannot close: it says nothing about launches that never wrote
the field, which is exactly what the incident consisted of. So `doctor` answers it as a **fact about
the machine** instead — which chat-enabled sessions have no capability, and the one command that
fixes them. The column keeps answering "would a restart change anything"; doctor answers "is anything
broken right now".

**A conversation that vanished is no longer read as a first launch.** Claude derives its history
folder from the working directory, so renaming a project relocates the conversation while the
registry still points at the old path. The expected file is then missing — indistinguishable from a
genuine first start, and the supervisor started a **new, empty conversation under the same uuid**.
Found on a live fleet: 140 MB and 37 618 records sitting under the previous directory's encoding
while a blank file was being written at the new one.

A session that has launched before has a stamp. If its history is gone anyway, something moved it —
so the supervisor now looks for that conversation elsewhere and refuses to start, writing a terminal
lifecycle block that names where the history is and what to do. It reuses the existing block
mechanism, which `list` and the TUI already surface and an explicit start clears. It does **not**
move the file: those are someone's data, and a uuid match in another directory can be picked wrong.
Blocking costs a stopped session; the alternative cost an unrecoverable overwrite.
## [0.13.0] — 2026-08-10

the record carries its generation; the receive path stops shelling out per ancestor

the record carries its generation; the receive path stops shelling out per ancestor

**Generation left the file names.** The clean cutover to the new chat identity model was right —
records written before it carry no provider or thread, and guessing those in would misroute mail.
Encoding it as `chat-v2.jsonl` was not: that name becomes a lie the moment there is a 3, and it
parked a dead archive beside live state under a near-identical name — the exact "is this junk?"
question the layout exists to end. The generation now lives in the record as its first field, the
live files keep canonical names forever, and superseded state moves under `archive/`, where the path
says it is not live. A foreign record is refused **by name** ("generation none, this build reads 2")
instead of by a complaint about a field shape, in both directions, and strict validation is
unchanged behind it. `chat log` no longer answers an empty log with silence when an archive sits
beside it: it says how many superseded files there are and where.

**The remote-receive gate got ~1000x cheaper on the platform that pays it.** Every inbound remote
message must prove it really descends from the transport, and the walk shelled out once per
ancestor. Measured before touching it: **104ms per message on Linux**, 6.6ms on macOS — the most
expensive step in delivery and the only one priced in process spawns. Reading the process tree
directly on Linux brings it to **0.099ms**; macOS keeps the targeted per-level query, unchanged.

The measurement killed both of the obvious fixes before they were written: caching per process buys
nothing (the receiver is a fresh process per message), and reading the whole process table in one
call was **five times worse** on macOS (hundreds of rows to walk two). Depth was never the cost.
## [0.12.0] — 2026-08-10

first-class managed Codex lifecycle and external ownership

Codex is now a first-class managed session provider instead of a transcript-only label.

- `new --agent codex` and the TUI share one transactional create path. The first Codex rollout is
  correlated exactly, promoted to its provider UUID, and resumed across child death, restart,
  daemon healing and machine reboot without minting a replacement conversation.
- External Codex threads are visible beside Claude with provider, origin, full thread UUID, storage
  and positive writer evidence. Adopt uses one atomic `codex resume`; native fork preserves the
  source history under a new UUID; takeover can signal only a freshly revalidated dedicated CLI.
  Desktop, editor, App Server, shared, self and unknown processes are never killed by ccmux.
- Managed chat routing now pins both endpoints to provider + machine + session + thread UUID. A
  queued or retried message cannot jump to a same-named replacement or to the Claude session beside
  a Codex session in the same directory. Version-skew and unknown providers fail closed.
- Chat/outbox state uses strict versioned envelopes and files. Historical unversioned chat state is
  left untouched as a read-only archive rather than guessed into the new identity model.
- Codex pane chat delivery remains intentionally unavailable until its composer, approval and turn
  frames are calibrated. Desktop-native Codex tasks continue to use the host's native task tools.
## [0.11.0] — 2026-08-06

one state root instead of scattered dotfiles

one state root instead of scattered dotfiles

ccmux kept its state in two places at once, and half of it sat as bare dotfiles in the home
directory — the registry among them, indistinguishable from junk next to a user's own folders. The
directory was decided by a REQUIRED config field holding a **file** path, with five other files
derived from that file's parent. So drift was structural: every machine answered the question
separately, and one careless value silently relocated the whole set into an unrelated folder.

Three roots now, split by **lifetime** rather than topic, so "can I delete this?" is answered by the
path itself:

```
<config>/ccmux/   machine.json                      a human edits this
<state>/ccmux/    sessions.jsonl, chat*, outbox*,   losing it orphans sessions
                  status/, ccmux.log, boot-attempts
<cache>/ccmux/    app/, staged/, releases/          one `ccmux update` rebuilds it
```

- `sessionsFile` is gone. In its place `stateDir` — a **directory**, derived from the platform's
  state root, that nobody normally sets. A required field made machines drift by construction; a
  derived one cannot. It survives purely as the single knob an isolated instance or a test flips.
- Every state file is **named** inside that directory by one module, so a file no longer decides
  where its neighbours live. The registry finally has an extension, which is why it used to be the
  one file that read as junk.
- No compatibility path: nothing reads the old locations. Both layouts being valid is exactly how a
  migration becomes permanent, and the window it opens is safe by construction — an empty registry
  means "nothing to supervise", so running sessions keep running untouched.
- `doctor` prints all three roots. The layout drifting unnoticed is what produced this in the first
  place.
## [0.10.2] — 2026-08-05

the RESTART column stops crying wolf across the fleet

fix: the RESTART column stops asking for a restart that would change nothing

It compared the version number as its own reason — the very thing the paragraph above it warns
against. Measured right after a daemon-only release: 22 of 23 live sessions were flagged `code`, and
re-launching any of them would have produced a byte-identical recipe (same hash, different version).

The version adds no true positives. Everything an upgrade changes inside a session is already in the
hashed argv — the prompt, `--settings` (inline JSON, not a path), the mode, the flags — and hooks
resolve the binary when they run, so a live session picks up new supervisor code without restarting.
A column that cries wolf across the whole fleet is worse than none: a real `chat`/`mode`/`config`
drowns in it. The stamp keeps `version` as diagnostics.
## [0.10.1] — 2026-08-05

a background shell made a session invisible to its own mail

fix: a background shell made a session invisible to its own mail

Found on an idle fleet: two sessions out of twelve reported `working` after two days of uptime, and
`ccmux wait` on them answered *"the recipient's UI has not painted yet (starting or resuming)"* —
about sessions that had been fully interactive since Sunday.

Readiness was keyed on `shift+tab to cycle`. That is a **hint**, not a piece of the interface. Claude
draws the footer as one line, and once the agent has background shells it puts their count where the
hint was:

```
⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
⏵⏵ bypass permissions on · 3 shells · ← for agents
```

Measured across the fleet, the hint was missing from exactly the sessions with background shells and
no others (pane width ruled out — 180-column sessions without shells kept it). So **any agent that
left a background command running was "not painted yet" forever** — and these agents use background
commands constantly.

One wrong marker, three symptoms in three subsystems, none of which looked like a bad marker:

- all of that session's deferred mail was held indefinitely (`not-drawn` is a hard gate, deliberately
  — a keystroke swallowed by a half-drawn UI would be acked as delivered and lost);
- every `wait` on it ran to timeout, giving a false reason;
- `list` printed `working` for it, because an untrusted pane falls back to the lifecycle record,
  where an interrupted turn leaves a stale `working` behind.

Readiness now keys on the **mode footer** — which every mode draws and nothing displaces — with the
default-mode footer, the interrupt hint and the old hint as independent fallbacks, so no single
cosmetic change can zero the signal out again.

fix: an unreachable sender is told so, instead of leaving the peer to find out

The fleet map is directional by construction: a roaming laptop reaches the servers, and nothing
reaches it back. A message from there arrives with a correct return address and no reply command —
and, until now, no explanation. A live agent completed its task, could not hand the answer back, and
spent five tool calls rediscovering the topology. The fact is known when the message is framed, so
it is now stated there, along with the one channel that does work. Callers that know nothing about
routing (the Telegram mirror) still print nothing — an absence of knowledge is not a fact.
## [0.10.0] — 2026-08-05

three ways a session looked busy while nothing was happening

fix: three ways a session looked busy while nothing was happening

Every one of them showed the same sentence — *"a human is typing in that pane right now"* / *"has not
finished its turn"* — about a session that was plainly idle, and every one had a different cause. The
common root was never the wording: it was measuring the wrong thing and stating the result with
confidence.

- **A turn that was killed never ends.** Readiness asked "how did the turn END" (last transcript
  record is assistant text) and never "is a turn RUNNING". After a restart mid-work the conversation
  ends on a tool result that no assistant line will ever follow, so deferred mail waited for an event
  that could not occur and `ccmux wait` ran to its timeout on a session answering people normally.
  The signal is not dropped and no alternative is bolted beside it: it is **demoted from a veto to a
  measure of confidence** — a turn that ended in words settles in seconds, anything else must be
  quiet far longer than any turn's internal pause. One expression, two thresholds, in a pure
  `turnState` that can finally be tested (it could not be before, which is why this shipped).
- **Claude's own autosuggestion is not typing.** The composer was read without attributes, and in
  that form a dim autocompletion is indistinguishable from text a human typed — so mail was held for
  as long as the suggestion stayed on screen. The pane is now captured **with** attributes once, dim
  runs are dropped before asking whether anything is there, and a half-typed line that Claude is
  completing still counts as occupied.
- **ccmux was typing into the agent** (fixed in 0.9.1) rounded out the set.

Along the way, from adversarial review of the above: the "UI has not painted yet" guard now covers
**every** mail track, not just deferred — a keystroke swallowed by a half-drawn pane used to be acked
and lost. Delivery no longer acks a write that failed. The ack is re-read immediately before typing.
`ccmux wait` distinguishes its three outcomes in words (all exit 0), tolerates a session vanishing
for a restart instead of reporting it gone, ignores mail that is scheduled for later or can never be
delivered, and names the real cause on timeout instead of guessing "still working". Hold reasons are
one sentence per cause, and the injected prompt — the only surface an agent actually reads — now says
plainly that exit 0 is not always "the work is done".
## [0.9.4] — 2026-08-05

send stops echoing your own text, and stops looking like a way to write to an agent

fix: `send` stops echoing what you just wrote, and stops pretending to be a way to write to an agent

- A confirmation that repeats the whole text charges twice for the same words — nothing for
  `/compact`, a lot for a multi-paragraph message, and an agent pays it out of the budget it needs
  for the work. `msg` already truncated; `send` did not. Both now share one helper: short text is
  shown whole, long text is cut **and its true length stated** (the length is what proves nothing was
  truncated on the way out).
- `send` reads like "write to a session" and only ever **presses keys**. Used for a letter it costs
  everything the reader needs: nothing is recorded, they cannot tell it from the human typing, there
  is no address to answer, and it types even into a selection menu or onto a half-written line. The
  prompt and `help` now say what it does rather than what it is called, and point at `msg`.
- A long non-slash message aimed at a chat-capable session gets a one-line nudge toward `msg`. Not a
  refusal — pasting long text on purpose is legitimate — and ccmux's own internal use (a restart's
  `--then` note) is exempt, since the advice would be for nobody.
## [0.9.3] — 2026-08-05

the fleet no longer lags a release behind a CDN cache
## [0.9.2] — 2026-08-05

Telegram mirror: bracketed route header with air under it
## [0.9.1] — 2026-08-05

turning the Telegram mirror on starts a live feed, not a history replay

fix: the fleet no longer lags a release behind a CDN cache

`ccmux update` sent `cache-control: no-cache` when fetching the release manifest, and the edge in
front of it ignored that: measured on a live host minutes after publishing, the header returned the
PREVIOUS version while the same URL with a query string returned the new one. Every release reported
"already on latest" on the first try, and auto-update would have held the whole fleet back the same
way. The manifest URL now carries a unique cache key.

Telegram mirror: the route line is now a bracketed header — `[dev:worker → prod:api] · task` — with a
blank line before the body, so on a phone the two stop running together. Mail to the human keeps the
same shape (`📩 [prod:api → you]`) rather than inverting the sentence: one route line to learn to read.

fix: turning the Telegram mirror on starts a live feed instead of replaying history

Enabling the mirror on a machine that already had chat history instantly re-sent all of it: the
progress cursor defaulted to `0`, which made every message ever written an "un-mirrored backlog".
Configuring a bot on two servers dumped 25 old messages into the chat. The cursor is now `null`
until the mirror first runs on that machine, and the first run adopts the present as its starting
point and sends nothing — a mirror is a feed of what happens next, not an archive replay. Existing
cursor files hold a number and are unaffected.
## [0.9.0] — 2026-08-05

prompt speaks in addresses; the Telegram mirror can cover the whole fleet

fix: the two places where ccmux itself pushed agents back to the old way

- **The hand-off block in the injected prompt never showed an address.** It said `wait <session>`
  while `<machine>:<session>` lived in a *different* block, so a cross-machine hand-off required an
  agent to join two halves by itself. It didn't: 1m51s after restarting onto that prompt (its launch
  stamp proves which prompt it had), a session wrapped everything in `ssh` again — the task arrived
  anonymous, the initiator kept no record, and the peer had no way to reply. Addresses now appear in
  every example, `ccmux fleet` is named as the way to discover one, and the ssh wrapper is banned
  **with its consequence** spelled out.
- **The polling ban described one shape instead of the substance.** It forbade "sleep + `ccmux list`
  + grep/awk"; the agent polled a *database* for a byte count, which that sentence doesn't cover — so
  it obeyed the words while doing the forbidden thing. It now bans deciding "done" by polling
  anything at all, naming pane, database, files and sizes.
- The chat block's duplicate of that recipe is **removed** — the knowledge lives in one place.
- **The Telegram mirror can now cover the whole fleet.** Every mirrored line is written as a fleet
  address (`dev:worker → prod:api`) instead of a bare name, because with several machines in one chat
  the same session name commonly exists on two boxes — the very ambiguity addressing exists to
  remove. Enabling it on each machine is config only: cursors are per-machine, so nothing is
  coordinated and nothing double-sends.
## [0.8.0] — 2026-08-05

list tells you which sessions a restart would actually change

feat: `ccmux list` now tells you which sessions a restart would actually change

- Everything that shapes an agent — its system prompt, the chat wiring, the permission mode, the
  supervisor code — is injected **at launch**, so a change lands only on the next restart. ccmux said
  so at the moment you acted (`applies on: ccmux restart …`), but a line that scrolls away is not a
  state you can check an hour later: which sessions were already restarted lived in someone's head.
- Each launch now records what it used, and `list` / `fleet` compare it against what a launch right
  now would produce. The new `RESTART` column names *what* differs — `code`, `chat`, `mode`,
  `modules`, or `config` — and is empty when a restart would change nothing.
- Deliberately **not** a version comparison, which lies in both directions: a release that didn't
  touch the prompt would flag every session for nothing, while `ccmux chat on` doesn't move the
  version at all yet certainly requires a restart.
- A forked conversation is not a config change (the re-pinned uuid is normalised out), and a session
  with no record yet shows nothing — unknown is never displayed as stale.
## [0.7.0] — 2026-08-05

cross-machine mail that couldn't leave is re-sent when transit returns

feat: cross-machine mail that couldn't leave is now re-sent when transit returns

- Transit between servers is **intermittent by design** — there are no server-to-server keys, so a
  machine can only reach another while the owner's forwarded key is present. A send attempted in a
  gap failed, and the honest `[NOT SENT — transport failed]` row was where it ended: an agent
  reported, moved on, and its report sat on disk while a peer waited for it. Observed live.
- The record is now a **queue that drains itself**. The daemon re-sends failed `msg` rows from the
  outbox — bounded to a one-hour window and a few attempts per tick, and never for `restart --then`
  (a hand-off is an action, not a letter).
- Safe because the send became **idempotent**: the message id travels with it, and a receiver
  ignores an id it already stored. A retry cannot duplicate — not even in the nasty case where the
  first attempt did land and only the sender read it as a failure. An older ccmux ignores the
  variable and behaves exactly as before.
- `chat log` stops reporting *NOT SENT* for something that arrived later; it says *sent later, on
  retry*. Optional `transitPreflight` (argv array in `machine.json`) runs once before a batch of
  retries for fleets that can restore transit locally — generic, off by default.
- **The key model is untouched.** Nothing gains access to anything; the fix is to survive the link
  being down, not to keep it up.
## [0.6.1] — 2026-08-05

a session could go permanently deaf to chat — ccmux was typing into it

fix: a session could go permanently deaf to chat — because ccmux was typing into it

- **`_run` no longer mirrors its log to stderr.** The in-pane supervisor shares a terminal with the
  agent it supervises, so a structured log line printed straight into that agent's UI and landed in
  its **input buffer** (verified: a keystroke sent to the pane edited the line in place). The
  "composer occupied" delivery gate then held every message for that session **forever**, reporting
  the reason as "a human is typing" when nobody was there. Found on a live cross-machine run; the
  gate itself is untouched — it was right, the pollution was ours. Every record still goes to
  `~/.ccmux/ccmux.log`; a failed spawn now says so in the pane as a plain sentence.
- **`ccmux wait` no longer races the message you just sent.** Delivery happens a beat after `msg`
  returns, so a `wait` fired immediately saw an idle pane and reported a finished turn that had
  never begun — in under a second, in the exact recipe we recommend. A session with undelivered mail
  is no longer considered settled.
- **`chat on|off`, `router on|off` and `inbox` accept a fleet address** like every other verb that
  operates on an existing session. Without it both a human and an agent fell back to raw `ssh`,
  which is what addressing exists to remove.
## [0.6.0] — 2026-08-05

fleet addressing — <machine>:<session> as a first-class agent address, with the return address and the whole exchange visible

feat: fleet addressing — `<machine>:<session>` as a first-class agent address, with the return address and the whole exchange visible

A session name only means something on one machine. Two boxes can each have an `api`, so a bare name
handed across a fleet is ambiguous — and an agent that resolves it locally reports to a stranger
while the one waiting hears nothing, with exit 0 the whole way. That happened, and it cost hours to
reconstruct because each machine's log knew only half of it.

- **Address.** `ccmux msg host-b:api "…"` — and the same for `start`, `stop`, `restart`, `rm`,
  `send`, `mode`, `logs`, `transcript`, `wait`. A bare name still means "here", unchanged. The
  machine label is the `rcPrefix` you already gave that box; a `fleet` map in `machine.json` points
  each label at an ssh alias. A remote send is **enqueued on the receiving machine** through its own
  `ccmux msg`, so it inherits every existing guarantee — menu/typing protection, rate limits, the
  ledger. `ccmux doctor` verifies each alias really is the machine it claims (and flags a label that
  duplicates this machine's own prefix, which could never be reached).
- **Return address.** Incoming cross-machine mail carries the sender's full address and, when this
  machine can actually answer, the exact reply command. A dispatched `restart --then` note is stamped
  the same way — that was the incident's original vector, arriving as anonymous text. The sender's
  address travels as an environment variable, not a flag: an older ccmux ignores an unknown variable,
  whereas an unknown flag was swallowed into the message body and destroyed the text (reproduced
  against the released parser). Both halves of the label are validated, so it cannot forge the
  `[chat from …]` tag it is rendered into.
- **Both halves of the exchange are visible.** `ccmux fleet` lists every session on every machine,
  each line a usable address. `ccmux chat log` now shows what this machine SENT as well as what
  arrived — including sends that never left — and `--fleet` merges every machine's log into one
  time-ordered stream. `ccmux inbox` names *why* a message hasn't landed (recipient stopped, chat
  off, scheduled, waiting for the turn to end, a human typing, rate-limited, or an agent that cannot
  receive chat at all) instead of an unexplained silence.
- Fixes along the way: a delivered `--defer` message no longer shows as pending forever; `inbox` no
  longer advances another session's read cursor; `restart <name>` on an unknown session exits 1
  instead of claiming success; unreachable machines are reported and never fatal.
## [0.5.1] — 2026-08-03

chat delivers while you watch a session — hold only while a human is typing

fix: watching a session no longer blocks its chat — delivery holds only while a human is actually TYPING

- Chat delivery was gated on "is a client attached to this pane", so simply watching a session with
  `tmux a` silenced its inbox **for as long as you stayed attached** — a letter sat undelivered while
  the daemon logged the hold every 3s and the sender had no idea why. Attached is not the hazard.
- The real hazard is narrow: injection appends a literal and presses Enter, so a human's *half-written
  line* would get our text glued onto it and sent. That is now what's tested — an occupied composer
  (the `❯` line in the pane's bottom frame, scanned only near the bottom so past messages, which
  Claude also prefixes with `❯`, are never read as live input), or a keystroke within the last 3s
  (`client_activity`, bridging the gap between two keys). Neither → **deliver, even while attached.**
- The selection-menu hold is untouched: injecting there would pick an option the agent never chose.
- Hold reasons are now named in the log ("human is typing" / "typed a moment ago") instead of the
  blanket "human attached".
## [0.5.0] — 2026-08-03

restart --all (TUI R), ccmux wait, transcript --last-message, self-explaining chat on

feat: `restart --all` (+ TUI `R`), `ccmux wait`, `transcript --last-message`, and a `chat on` that tells you what's next

- **`ccmux restart --all`** (TUI: `R`, behind a confirm) bounces every session on the machine so a
  changed rule set / MCP config / ccmux release lands everywhere at once. The sweep runs in a detached
  driver and restarts sessions **strictly one at a time** — killed and started before the next is
  touched — so the tmux server never empties (it dies with its last session, dropping attached clients)
  and the daemon never sees a fleet-wide outage. It follows conversation forks before each restart,
  waits for the old agent process to actually exit (no two-writer fork), skips archived sessions, does
  the calling session last, and refuses to run twice at once.
- **`ccmux wait <name>`** blocks until a session voluntarily finishes its turn — exit `0` settled,
  `2` timed out (`--timeout N`, default 300s), `1` unknown/stopped. It reuses the exact readiness test
  deferred chat delivery uses, so the two can never disagree, and needs no chat: any script can wait
  for an agent instead of polling `ccmux list` in a loop.
- **`ccmux transcript <name> --last-message`** prints just the agent's final answer as plain text, in
  full (`list --json` carries it clipped to 280 chars) — the "take the report" gesture in one command.
- **`ccmux chat on`** now says `applies on: ccmux restart <name>` (matching `router on`) plus the next
  step, closing the trap where chat was enabled, nothing appeared to happen, and the reason — the hook
  and framing are wired at launch — was invisible.
- README gains a **Coordinating agents** recipe (enable → restart → hand off → `wait` → take the
  report), including the explicit "chat is machine-local, keep orchestrator and workers on one host".
## [0.4.0] — 2026-07-30

Claude session status from structured sources (statusLine JSON + hooks), not pane-scraping

feat: Claude session status from structured sources (statusLine JSON + hooks), not pane-scraping

- Context %, model and cost now come from the STRUCTURED JSON Claude Code feeds its statusLine command
  (`context_window.used_percentage` × `context_window_size`), captured by an injected statusLine
  wrapper that ALSO runs the user's own statusline unchanged (or renders a minimal `model · ctx%`
  default if they have none). This removes the regex-over-rendered-text scrape and its dependency on
  the user's statusline FORMAT, so context % now works on default Claude Code and any user's setup —
  not only a bespoke statusline — with no hardcoded model→window map (the window size comes from Claude).
- Turn-boundary hooks (UserPromptSubmit/Stop/SessionStart) write a per-session working/idle lifecycle
  file. Working/idle display stays pane-decisive (the spinner is reliable and, unlike the hooks, reads
  idle correctly right after an ESC-interrupt); the hook fills only the cold-start gap and `SessionStart`
  clears a stale `working`. The lifecycle file is the substrate for future event-driven push/"waiting".
- Both inject via `--settings` and coexist with the chat Stop hook; status files live under
  `~/.ccmux/status/` and are cleared on stop/rm/restart. Fully fail-open — a status/statusline hiccup
  can never wedge a turn or corrupt the rendered bar.
## [0.3.0] — 2026-07-30

Codex launch/resume (close the launch gap) + shell completions

feat: Codex launch/resume (close the launch gap) + shell completions

- **Codex sessions now launch and resume through ccmux**, 1:1 with Claude as far as the Codex CLI
  allows. Codex has no `--session-id` (a fresh session mints its own rollout id) and no
  `--append-system-prompt`, so: the first launch injects the ccmux management instructions as the
  leading positional PROMPT, and a new `detectFork` reconciles Codex's self-assigned id back into the
  registry through the SAME follow-fork pipeline Claude uses — after which `codex resume <uuid>` tracks
  the real conversation (no prompt re-injected on resume). RC has no Codex equivalent (that's a
  claude.ai feature), so it stays Claude-only. The root daemon strips Codex's `--dangerously-bypass-*`
  switches, mirroring the Claude root guard.
- **`ccmux completions <bash|zsh|fish>`** — prints a shell completion script generated from the same
  `COMMANDS` registry `ccmux help` uses, so a new/renamed verb can never drift from what completes.
- Test coverage filled in for the transcript adapters (Claude tool-call folding + Codex response items),
  the `list` context-label parse, and the TUI width/wrap primitives.
## [0.2.1] — 2026-07-29

model from transcript (source of truth), not the statusline whitelist — a new Claude family (Fable/Mythos) is never shown as a blank model again

fix: session model is read from the transcript (source of truth), not scraped from the statusline against a family whitelist — so a new Claude family (Fable, Mythos, …) is never shown as a blank model again

- `ccmux list` reported `model: null` for sessions on any family the pane scraper hadn't been taught.
  The model was matched with a `(Opus|Sonnet|Haiku)` regex against the rendered statusline — a
  whitelist that silently dropped Fable 5 (and would drop the next family too), and that depended on
  the user's arbitrary custom statusline and reflected the start-time model, not the current one.
- The model now comes from the transcript's `message.model` (Claude) / `turn_context.model` (Codex) —
  the source of truth, always fresh, format-independent. `<synthetic>` turns are skipped and only real
  assistant turns are trusted (image-gen model ids live in tool payloads). Display formatting is a pure
  transform (`prettyModel`: `claude-fable-5` → "Fable 5"), never a lookup table, so a future family
  renders with zero code change; anything off-shape falls back to the raw stripped id.
- The pane scraper keeps only genuinely-live signals (working/idle, best-effort context); its old
  double-duty "model → booted" gate is replaced by a statusline-independent `ready` marker. The
  managed-list and external-discover paths now share one model source and one formatter.

fix: shipped bundle is truly self-contained — stub react-devtools-core at build time so a cache-cleared / offline machine no longer dies on start with ENOENT; + guard test against future hoisted externals

- Fix the shipped bundle silently depending on the global bun cache / npm at startup. ink imports an
  optional DEV-only React DevTools client (`react-devtools-core`) via a HOISTED static import, so it
  loaded on every launch — and built with `--external` it resolved that import at runtime against
  `~/.bun/install/cache` (or an npm auto-install). A machine whose cache was cleared, or that had no
  network, died on start with `ENOENT ... react-devtools-core` — the daemon (and every session it
  supervises) down. The "self-contained" bundle was never actually self-contained. The build now
  compiles an inert stub in its place (`Bun.build()` API + a resolve plugin instead of the
  `bun build --external` spawn), so the single-file bundle carries no external import and starts
  offline / with an empty cache. The bundling moved to `scripts/bundle.ts` (one build path shared by
  stage / CI / release), the misleading "never reached in prod" comment and the obsolete "build only
  outside the project tree" caveat are gone, and a guard test builds via that same path and asserts
  the bundle starts under a wiped cache + dead registry — so this can never silently regress.
## [0.1.19] — 2026-07-25

session-reader library seam — expose the tested block-parser as 'ccmux/session-reader' for external consumers (readSession/parseSession/detect + types), lean (no ink/react), inert for the fleet bundle

- Expose the transcript reader as a library — `ccmux/session-reader` (`src/lib.ts` + a package.json
  `exports` subpath). `readSession(path, agent, textLimit?)` / `parseSession(lines, agent, textLimit?)`
  / `detect(lines)` plus the `TranscriptMessage` types, so an external consumer reuses the tested,
  agent-agnostic (Claude + Codex) block-parser instead of duplicating it. `textLimit` is a passthrough
  (default 6000; pass higher for full-text indexing). Lean by construction: the seam wires only the
  PURE parsers + `readLines` + types, so importing it pulls in `zod` + `node:fs` — not ink/react/tmux
  (verified: `src/lib.ts` bundles to ~15 KB with zero ink/react in the subgraph). Inert for the fleet:
  the shipped bundle is built from `cli.ts`, and `exports` only affects external `import "ccmux/…"`
  resolution. The format sniff moved to `src/agent/detect.ts` (normalize-only deps) and is re-exported
  from `agent/index.ts` under its existing name.
## [0.1.18] — 2026-07-24

fix: 'ccmux update --check' is now read-only and a stale/older staged bundle can't silently downgrade a machine

- Fix `ccmux update --check` mutating the machine. With a leftover staged bundle present (a forgotten
  `bun run stage`), `--check` applied it instead of just reporting — and applied it even when it was
  OLDER than the running version, silently downgrading. Two root fixes: (1) the update decision is now
  a pure `decideUpdate` that `--check` can only ever ask for a `print` from — read-only by
  construction; (2) a staged bundle wins only when NEWER-or-equal than the running version (an
  unreadable one counts as not-newer) — a stale/older staged build is refused as a downgrade unless
  `--force`, with a message pointing at the forgotten file. The legit "test a newer build locally"
  path is unchanged.
## [0.1.17] — 2026-07-24

chat-layer follow-ups from acceptance testing: cancellable watchdogs (msg cancel + --task dedup), honest single-source usage, stdin body, --after+--defer trap warning

- `ccmux msg cancel <task>` — drop a sender's still-undelivered mail for a task (an armed `--after`
  watchdog or a queued `--defer` that hasn't fired). Cancellation is a tombstone in the append-only
  ack-log (`by: "cancel"`), the same log the daemon and the Stop hook already consult — so a cancel
  suppresses delivery in BOTH channels with no new coordination surface and no ledger rewrite.
  Scoped to the sender, so a session can never cancel another's dispatch; already-delivered mail
  can't be un-sent.
- Watchdog dedup by task: re-arming a conditional (`--defer`/`--after`) with the same
  `(sender, recipient, task)` now REPLACES the sender's prior undelivered one instead of piling up a
  duplicate ping — closing the router's "two identical watchdogs both fired" gap. Immediate mail is
  never replaced (it's delivered at once).
- `--after` + `--defer` now prints a note on send: the two multiply to "not before T AND only at a
  turn boundary", so a self-watchdog armed that way won't arrive on time in a long turn — a watchdog
  should use bare `--after` (delivered between tool calls). Not blocked; the flags are compatible.
- `ccmux msg` reads the body from stdin (`echo "…" | ccmux msg <to>`) when no inline text is given
  and stdin isn't a TTY — matching the rest of the toolchain.
- `ccmux msg --help` now shows the full flag set (`--defer`/`--after`/`--on-behalf-of`/`cancel`). The
  short help and the arg-error usage were two separate strings that had drifted; they now render from
  one source, so they can't diverge again.
- `ccmux inbox` help clarifies it's the fallback for held/offline mail, not an archive — a message
  already pushed into a pane doesn't sit there.
- Diagnostic: the daemon now logs when it HOLDS a pending message solely because a human is attached
  to the recipient's pane (delivery resumes on detach) — so "the message never arrived" is traceable
  to that transient cause instead of looking like a broken chat.
## [0.1.16] — 2026-07-24

inter-agent deferred chat + autonomous router sessions + time-delayed watchdog delivery

- Deferred chat delivery: `ccmux msg <to> --defer` holds a follow-up until the recipient
  VOLUNTARILY finishes its turn, then delivers it as if a human typed it — never interrupting
  mid-work (Claude's native queue is steering; it flushes between tool calls). Delivered by a
  Claude Stop hook the instant the turn ends, or by the daemon once the target is stably idle
  (spinner off + assistant-message-last + transcript quiet for a grace window). The Stop hook is
  auto-provisioned at launch, merged into a single `--settings` object (verified it does not
  clobber the user's own hooks). Coordination is an append-only ack-log keyed by message id —
  the daemon stays the sole writer of the delivery cursor, so there is no lost-update race and no
  `block`-loop.
- Router sessions — an autonomous manager. `ccmux new <name> <dir> --router` / `ccmux router
  on|off <name>` gives a session a versioned "manager protocol": it routes an owner-dictated
  follow-up to the right target with `--defer`, waits, validates the result against a stated
  done-criterion, re-asks on a gap (bounded), and escalates to the human ONLY when genuinely
  stuck — never nagging with "continue?". Activated via a `promptModules` data field (a key into
  an in-code module registry, resolved fresh at every launch — no stale snapshot), so it's a
  capability toggle, not a persisted role.
- Time-delayed delivery: `ccmux msg <to> --after <sec>` (a `notBefore` instant). A router arms a
  self-`watchdog` per dispatch, so a target that finishes but never reports back no longer hangs
  it — the timer returns control, the router checks the transcript and closes or escalates on its
  own. Delivery is now two-track — immediate mail flows in order through the cursor, while
  deferred / time-delayed mail is delivered by id off the cursor, so a pending conditional message
  never head-of-line-blocks an immediate reply behind it.
- Honest relay provenance: `ccmux msg --on-behalf-of <who>` renders "on behalf of <who>" so a
  router can carry the owner's authority without ever spoofing the sender — gated so only a router
  (or the cli) may relay, never a plain peer.
- Owner-language: sessions reply to `owner` in the owner's own language by default; an optional
  `ownerLang` in machine.json forces a fixed language.
## [0.1.15] — 2026-07-19

inter-agent chat (menu-safe pane delivery + one-way Telegram mirror) + isolated dev instance

- Isolated dev instance: run a full second ccmux (daemon + sessions + chat) beside prod on one
  machine, fully isolated — a `tmuxSocket` config scopes every tmux call to its own server (`-L`),
  `CCMUX_HOME` overridable for its own app/log/boot-state, `remoteControl:false` keeps its sessions
  out of the claude.ai app. tmux doesn't propagate env into panes, so `new-session -e` pins the
  instance's `CCMUX_HOME/CONFIG/SESSIONS`, and the injected prompt teaches the instance's own cli
  (not the prod shim) when `CCMUX_HOME` is non-default. Scaffold + teardown via `scripts/dev-instance.sh`.
- Inter-agent chat, sender identity: the sender is automatic and unspoofable — an agent sends as its
  own session, a command-line invocation as `cli`; there is no `--from`. `owner` is a reserved
  recipient (the human — Telegram-only, no pane); the injected prompt frames `[chat from owner|cli]`
  as the human side (user-level trust) vs `[chat from <peer>]` as a fellow agent.
- Dev daemon hot-reload: `bun daemon:watch` (= `bun --watch src/cli.ts daemon`) restarts the
  process on any source change — fresh timers each time, unlike `--hot`, which re-runs the entry
  WITHOUT tearing down the old `ensure`/chat loops (they'd accumulate; proven with a `Bun.sleep`
  probe). The boot-loop guard is now skipped when running from live source (`IS_DEV`): it protects
  the auto-updated prod bundle (revert to `.bak`), has no bundle to revert in dev, and would only
  churn false "boot-loop" errors under rapid `--watch` restarts.
- Telegram chat mirror: the routing header (`from → to`, or `📩 for you — from …` for a message to
  the human) is now bold (HTML parse_mode) so who-is-talking-to-whom reads at a glance; the message
  body is HTML-escaped so `<`/`>`/`&` render verbatim and never trip a 400 that would drop the message.
- Inter-agent chat: opt-in messaging between managed sessions. `ccmux msg <to> "..."` /
  `ccmux inbox` / `ccmux chat log|on|off`, with a per-session `chatEnabled` flag (default off).
  The daemon push-delivers into the recipient's pane on a fast cadence, tagged `[chat from X]`
  (framed to the agent as a peer, not the user), gated so it never injects at a selection menu
  (would auto-pick an option — proven live) or while a human is attached; a busy recipient just
  gets it queued at its next turn boundary. In-order per recipient, no double-push across daemon
  bounces; loop/rate guards cap a runaway A→B→A. An append-only ledger (`~/.ccmux-chat.jsonl`) is
  the source of truth; multi-line bodies deliver via bracketed paste. Optional one-way Telegram
  mirror (`telegram` in machine.json → group/DM/topic; fail-soft, outbound only).
## [0.1.14] — 2026-07-19

auto-answer Claude's resume-from-summary picker so daemon-healed reboots don't strand large sessions at the menu

- Auto-answer Claude's blocking "Resume from summary?" picker on an unattended resume. Claude
  2.1.x shows this menu on `--resume` of a large/old session; a daemon-healed reboot had nobody
  to answer it, so big sessions stranded at the menu (typed input — app or tmux — landed on the
  menu, not the conversation) until a human manually restarted each one. The `_run` supervisor now
  watches the freshly-resumed pane and answers per a new `resumePicker` machine-config policy
  (`full` = keep all context [default] · `summary` = compact · `off` = leave for a human). It reads
  the option NUMBER from the pane (robust to reordering) and confirms with Enter only if the number
  key didn't. Claude-only; other agents have no such picker.
## [0.1.13] — 2026-07-17

injected prompt teaches bare ccmux shim, not the absolute bun path

- The sibling-management prompt injected into each session now teaches the bare `ccmux`
  command (the PATH shim) instead of an absolute `bun …/ccmux.js` path, so fleet agents
  call it cleanly. Falls back to the absolute invocation only when the shim isn't
  installed. The machine re-execs (supervisor, boot unit, restart-worker) stay absolute.
## [0.1.12] — 2026-07-17

per-session permission-mode override

- Sessions get an optional `permissionMode` that overrides the machine-wide default
  (`MachineConfig.permissionMode`). Undefined → inherit the machine default, so existing
  sessions and configs are unchanged. Lets one box run bypass by default while a specific
  session (client-prod, untrusted-input) stays gated at `auto`/`plan`.
- New `ccmux mode <name> <mode|default>` sets/clears the override (`default` = inherit the
  machine default). It's a launch-time flag → `ccmux restart <name>` applies it.
- The root-guard is unchanged and still applies to the resolved mode: under a root daemon,
  escalated modes (`bypassPermissions`/`dontAsk`) still downgrade to `auto`, whether they came
  from the machine or the session.
## [0.1.11] — 2026-07-16

transcript whole-session composition stats

- transcript: whole-session `stats { messages, user, assistant, toolCalls, thinking }` on every
  `--json` response, counted over the ENTIRE JSONL (not just the loaded window) and cached by
  mtime — idle sessions cost nothing, active ones recompute only when they move. Lets a viewer
  show true session composition that doesn't drift as you paginate.
## [0.1.10] — 2026-07-16

transcript backward pagination — infinite-scroll-up

- transcript: backward pagination for infinite-scroll-up. `transcript --json --before <line>
  --limit <n>` returns the `n` lines ending just before `<line>` (line-based, so it's robust to
  lines that carry no message — blank / folded tool_result), and every response now carries
  `window { firstLine, lastLine, reachedStart }` so a consumer can page older until line 1.
  `parse` gained an optional `endLine` upper bound (claude + codex parsers).
## [0.1.9] — 2026-07-16

transcript: full tool input + result output for the expanded card

- transcript: `TranscriptMessage` gains `input` (the tool_use input as pretty JSON — the actual
  command/args) and `resultText` (the paired tool_result's full output), both clipped to the
  display text limit. Consumers can now render a real request→response body per tool call
  instead of only the one-line summary. Claude + Codex parsers emit both; null for non-tool
  messages and still-running calls.
## [0.1.8] — 2026-07-14

release pipeline v2 — CI-only publishing

- Release pipeline v2: releases are born only from tags via CI (gate: typecheck + tests +
  bundle smoke); local `--publish` removed; `bun run release X.Y.Z "notes"` is the one
  ceremony (clean-tree guard → check → bump + changelog → commit → tag → push).
- Pre-push git hook runs `bun run check` (wired via `core.hooksPath`).
## [0.1.7] — 2026-07-14

- Follow the fork: the registry re-pins a session to the new session id when Claude Code
  forks the conversation (out-of-context continuation) — previews, transcripts, activity
  and the next restart follow the live conversation instead of a dead file.
- External discovery ignores processes living inside managed panes (a fork leaves the
  pane's stale `--resume` argv looking like a live external session showing a dead
  conversation).
- TUI: fleet sorts by last conversation activity (minute-bucketed, no per-tick reshuffle);
  cards show the activity age (`5m ago`) next to uptime; selection follows the session
  (uuid), not the list position.

## [0.1.6] — 2026-07-11

- Configurable permission mode (all Claude Code modes) in machine.json; escalated modes
  are downgraded to `auto` under a root daemon (server safety guard).

## [0.1.5] — 2026-06-24

- `rcPrefix` is a free-form slug, not a `local|dev|prod` enum — the fleet grows past
  three machines.

## [0.1.4] — 2026-06-23

- Discover live external sessions by process (ps scan), not file mtime — a desktop-app
  open no longer surfaces dead sessions as live.

## [0.1.3] — 2026-06-22

- Add the bun bin dir to the daemon PATH (defense-in-depth for auto-update).

## [0.1.2] — 2026-06-22

- Fix daemon auto-update preflight (bare `bun` not in the launchd PATH).

## [0.1.1] — 2026-06-22

- Fix `ccmux install` ignoring `--release-url` over an existing config.

## [0.1.0] — 2026-06-22

- First public release: persistent self-healing Claude Code tmux sessions with
  deterministic resume, fleet daemon, TUI, GitHub Releases auto-update.
