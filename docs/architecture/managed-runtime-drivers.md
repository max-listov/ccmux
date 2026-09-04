---
title: Managed runtime drivers
description: Capability-aware native session supervision with exact continuation and bounded control projection.
type: architecture
status: active
created: 2026-08-30
updated: 2026-08-30
---

# Managed runtime drivers

The managed registry owns a session's address, workspace, registration generation and UUID.
A driver owns its protocol and continuation evidence. Codex uses its native UUID; OpenCode keeps
its `ses_…` identifier separately. Runtime identity is not an inference provider or a model.

## Ownership and state

The existing create journal and pending-registration transaction are the only admission ledger.
Admission is reserved before a native create. A durable intent prevents repeating a create or
prompt with an uncertain response. Reconciliation must find the exact registration/native request;
absence or ambiguity fails closed, never creates a replacement conversation.

The supervisor owns only children it launches. An owned OpenCode server binds authenticated
loopback on an ephemeral port. Its credential exists in process memory/environment, not argv,
receipts or projections. No endpoint or executable is accepted from a control caller. The server's
native store remains authoritative; CCMux does not import that store into a second transcript DB.

`reserved → starting → ready → working → waiting-input/approval → terminal` describes admission
and turns. Disconnection changes availability, not the last terminal outcome. Only native terminal
evidence correlated with an admitted input completes it. Restart reuses the same native identity;
archived registrations are excluded from healing and retain their history.

## Capability boundary

Claude has two execution modes. The default keeps its interactive provider and truthful pane-based
capabilities; an opt-in native mode drives the same installed binary through the published agent SDK
and reports the structured surface the other native runtimes report. Codex uses App Server.
OpenCode uses the native SDK/API and SSE. A custom driver composes a published optional harness;
it does not implement an inference loop, tool scheduler, product prompts or credential routing.
Capabilities are explicit per driver. An unavailable driver or unsupported operation is rejected
before registry mutation. Cross-machine transport dispatches the same typed control operations.
Custom ships in the installed CLI and is configured only when the execution host defines a Custom
launch recipe. So `custom` reporting `unavailable` in `runtime.list` means this host has no recipe,
never that the runtime is missing or unreleased — the two states read alike from outside and are
told apart only here. The composed harness version lives in the manifest, not in this prose.

Prepared native projections are bounded in bytes, events and requests, leased by observation time
and tied to producer liveness. Native identifiers, selected model/provider and runtime version are
evidence; launch secrets and provider error payloads are not public metadata. Exact generation and
request identity gate approval/input responses. A stale response must not resolve a new request.

## Public use and limits

`client['runtime.list']({})` / declared-service `runtime.list` returns runtime availability and capabilities.
`configured` means an owner binary is configured, not that its account or every model is ready;
admission checks the actual native version and protocol. `create({ runtime: "opencode", requestId,
name, workspace, modelSelection: { provider, model } })` uses the same create/message/native/respond/
interrupt/wait/archive methods as Codex. `models({ runtime: "opencode" })` discovers configured native
providers before a chat. Session-scoped model reads use that exact writer's prepared catalog.

OpenCode requires 1.18.20 or newer and the pinned SDK 1.18.20. Configure/install `opencodeBin` on the
execution host and authenticate using OpenCode itself. The control caller supplies no credentials.
CLI creation is `ccmux new agent-a ~/code/demo --agent opencode`; native input and history use the
control service, not an invented terminal composer. OpenCode does not accept Codex launch recipes or
caller flags. Claude exposes its existing interactive lifecycle, not native model/request parity.

HTTP non-image JSON reads are capped at 2 MiB and each non-image SSE frame at 256 KiB. OpenCode echoes
input images inline; a bounded lexical pass elides only native PNG/JPEG data-URL payloads before
JSON allocation (8 MiB per image, 16 MiB aggregate encoded images). Other fields keep their original
ceilings. Startup reconciles the most recent message and its exact parent, not lifetime history.
Admission buffering is 128 events/512 KiB, status projection 128 items/128 KiB, pending requests 16.
Content/history have separate [bounded current contracts](native-content-and-turn-controls.md).
Question responses preserve native option labels, multiplicity and exact question/request IDs.
The native process owns its full transcript; the control feed intentionally omits tool inputs,
outputs and provider error payloads. Last private native diagnostics are bounded owner-only files
under `native-diagnostics/`, not streamed metadata or stderr mirrors.

A cursor intent is durable before dispatch. Recovery may materialize a missing queued mailbox only
when no unresolved old native receipt exists. Corrupt state and uncertain native admission hold;
neither prompts nor approval/input responses are replayed automatically. Daemon restart does not
stop the provider child. Provider restart changes observation generation, not managed/native IDs.

`scripts/opencode-runtime-e2e.ts` runs an isolated real daemon and provider sessions, exercises native
tools/approval/input, exact retries, busy/defer, interrupt, cross-runtime chat, daemon restart and
provider resume. It requires existing native account access; it does not install credentials or
modify a production registration. `scripts/custom-managed-acceptance.ts` runs the built Custom
entrypoint through the same public service with existing operator-owned credentials and private
fixtures. Its optional coexistence, coding and resident lanes report independent outcomes.

## Custom execution owner

`src/agent/custom/process.ts` holds the existing managed owner lock. One Harness and SQLite store
own a conversation whose native ID is the managed registration generation. Launch recipe identity,
revision and digest pin the environment, model registry, allowed tools, executable aliases and
resource source digests. Callers supply only the immutable recipe reference and typed selection.
The existing environment resolver is reused; provider and signing keys are not copied into tool
command environments. Only explicit host environment names and the existing scoped chat identity
are passed to commands. The service does not expose executable aliases as a caller shell gateway.

A recipe may also name contract services whose operations become tools of the session. Custom exists
to run this system's own loop on a machine that is not the consumer's, so a session that can read
and write files and perform none of its owner's operations is only half the runtime. The recipe
names an executable on the host; `src/agent/custom/services.ts` spawns it and speaks MCP over its
stdio, and the tool list with its JSON Schemas arrives by handshake. Two properties decided that
form over reading a document or importing a module: no third-party code enters the supervisor
process, which holds every session's approval secret and provider credential, and no schema is
written down twice, so there is no second place for one to go stale. The trust boundary is the one
`executables` already draws — a child process the host declared. Those children belong to the
session: they are closed with it and with a composition that fails, because a supervisor that leaves
them behind is the orphan case this project already knows.

Admission is the recipe's alone: an operation the server offers and the recipe does not name is
never mounted, so widening a session's reach is a recipe change and a new digest rather than a
change on the far side. The child receives only the environment name the recipe declared for it,
never this process's own. That credential is read while the recipe is prepared, so a missing key
fails there instead of arriving as a service refusal attributed to whichever turn called first. The
mounted set passes the same tool fence and prompt-schema budget as the coding tools. The converter
reads strings, numbers, booleans, string enums, arrays and nested objects; anything else is refused
by name and the session refuses to start, because a guessed input schema is a tool the model calls
wrongly forever with nothing pointing back at the cause.

The names a recipe may declare for coding tools are the names the harness composes — one set, not
two. `run_command` requires a declared executable and `read_resource` a declared resource, and both
are checked where the recipe is accepted so a recipe that cannot run earns no digest and never
reports `configured`. Coding tools and service operations are declared in different fields and are
one set from there on: `declaredCustomToolNames` is what composition admits a session with and what
the applied-profile check measures the observed profile against, and the bound on the retained
profile is that set's size rather than a number of its own. A second reading of the recipe on either
path is a copy that can disagree, and a check that admits fewer names than composition kills a
session the recipe schema accepted.

The host also names which adapter serves that registry. `openrouter` reaches the aggregator and
requires its credential; `local` reaches an OpenAI-compatible model server on this host or its own
network, and its credential is optional because the common local servers accept requests without
one. `src/agent/custom/provider.ts` composes the published adapter for the configured kind into the
same two-method provider the model registry consumes, so the harness, canonical store, tool loop and
approval flow do not vary by provider. Every model declares the kind that serves it and the catalog
publishes that kind as the provenance of an answer; a model whose provider does not match the host
adapter is invalid configuration rather than an unresolved provider at the first turn.

`local` is decided from the address rather than asserted by the label. `src/agent/custom/endpoint.ts`
accepts an http or https URL whose host is `localhost` or a loopback, private or link-local address
literal, carrying no embedded credential, query or fragment, and it resolves no names. A public
endpoint therefore cannot be declared local, which is what makes the published provenance a fact and
forecloses a silent reroute to a hosted provider. Endpoint and credential stay in host configuration
and appear in no catalog page, selection evidence or caller input. Token counts a local server
reports are `provider-reported` and counts it omits stay `unavailable`; local inference reports no
price, so cost is `unavailable` rather than zero.

A local provider may also carry a host-declared `label` naming the server behind it. `kind` answers
where the work ran and is checked against the address; it cannot answer what served it, so a host
running two local engines would otherwise publish identical provenance for both. The label rides
beside that fact in the catalog page and in the applied profile, is never matched on, and is never
part of `selection.provider`, which is compared against the host adapter. It is free-form within a
narrow charset because an OpenAI-compatible adapter exists precisely so the server need not be one
this project has heard of; the value is recipe configuration pinned by digest, not caller input.

`ccmux models <launch-recipe-id>` checks a declared registry against the provider that must serve
it: per model, whether the provider currently serves that id, and whether a context window the
provider published contradicts the declared one. It stays a diagnostic — never a startup dependency
and never a turn-time probe — so an unreachable provider yields `unknown` rather than `missing`, and
a fact the provider does not publish stays declared and unverified rather than being called agreed.
Exit codes separate the three outcomes: settled, contradicted, or could not look. The registry is
never populated or edited from what a provider lists; a server offering a model is not authorization
to use it.

`custom` supports native text, image-capable configured models, history, selection, signed tool
approval, interrupt and resume. It does not advertise fork, compaction, rollback, steering, native
question input or caller application-policy mutation. Unsupported operations refuse before mutation.
Host-defined resources use the published lazy resource tools. `nativeProfile` reports only the actual
model, approved tool names and safe resource IDs/digests, never resource bodies or private paths.

The chat ledger remains the FIFO/defer queue. Its one-item native mailbox records accepted options
before Harness submission. The canonical user input ID and run ID bind the original message;
run input IDs, not a nonexistent user-message run field, prove that binding. Signed approval ends
the producing native run without completing the managed message. Its response admits a tool-role
input and a distinct successor. Bounded `continuations` retain the original `turnId`, parent run,
request, response operation/fingerprint, actual successor and decision. A repeated exact response
reconciles; a changed answer conflicts. An uncertain response is not blindly replayed.

Queued canonical work may resume. An interrupted owner with unresolved executing effects remains
held as `prior-owner-execution-unresolved`; automatic replay is prohibited. Completed inputs and
pending signed approvals are restored from the same store, with a stable host signing secret.
Client detach never closes the Harness. Worker shutdown cancels commands, drains observation,
closes the engine and then releases its owner resources.

Transient event epoch/sequence and durable event IDs are distinct. Duplicate events are ignored;
a gap invalidates content until bounded canonical reconciliation. Status is limited to 128 KiB,
128 metadata items and 16 requests; correlation reads at most 128 recent canonical records and
32 continuation runs. Existing content/history limits apply separately. Prepared status reads do
not submit model work or open a second canonical-store writer. Tool exit 7 is a failed tool even
when the enclosing model turn reports success. Internal model errors are retained through an
operator-only bounded observability sink, not public content or stderr mirrors.

The installed CLI embeds a digest-verified Custom runner and the published Darwin file addons.
`custom/package.ts` materializes immutable private package bytes under the configured state root;
no execution depends on the source checkout, network installation or temporary release repository.
Linux uses the package's contained-files backend. Package directories and native history survive
archive and are not deleted to make an incompatible rollback appear successful.

## Diagnostic journal boundary

`src/runtime/journal.ts` provides a metadata-only factory over the published Stitchkit journal.
Its strict schema accepts lifecycle categories, registration/message UUIDs and hashed native
correlation, not names, prompts, tool arguments or raw failures. Raw causes remain in the separate
private diagnostic facility. Daemon and worker identities resolve distinct fixed journal paths.

The limits are 8 KiB per event, 256 queued items/1 MiB, 2 MiB per file and four files per writer.
Admission refusal counters, physical-write status, rotation and partial-tail evidence remain
observable. Admission into memory is not durable delivery, fsync or native-turn completion.
`src/runtime/journalOwner.ts` integrates the daemon and Custom worker lifetimes. A private PID claim
and existing owner-aware directory lock authorize removal of only an upstream lock whose writer
is positively dead. Unclaimed, live or reused PID locks refuse; journal data is retained. Status
counters are persisted with a one-second cadence and at bounded close. Request, answer, interrupt,
gap and terminal transitions carry only allowlisted metadata. Other native engines retain their
existing private diagnostics; no journal is used as their canonical execution state.

## Upgrade and rollback

Runtime selection defaults to Codex at the public create boundary; accepted create identities remain
immutable. Current content/control clients must match the released descriptor. An older observer
cannot produce the new content projection: a daemon-only update does not upgrade existing native
writer code. Resume those writers at a safe boundary and verify the new projection generation.
Do not interrupt unrelated active work merely to manufacture parity. Native state requires this release or newer,
including archived rows: archive retains their runtime and continuation fields. A bundle-only
rollback cannot make an older parser understand them. Before native admission, retain a registry
backup. If rollback is necessary, stop native writers and the daemon, preserve the current registry
and journals, and restore a verified compatible registry snapshot before starting the older daemon.
Do not roll back if that snapshot would discard later registrations or identity changes; use a
forward fix instead. Never delete native history or silently relabel a row as Codex.

## Reference implementations

the external reference harness
separates its provider registry, owned-server lifetime and native continuation cursor. Its OpenCode
adapter handles prompt-admission races and correlates assistant messages with native parent IDs.
CCMux uses those ownership principles, not its UI, orchestration framework or application loop.

[OpenCode 1.18.20](https://github.com/anomalyco/opencode/tree/7248bc1964b13fa67e601733f89ee9dc6dfa0563)
provides authenticated HTTP control and structured SSE. `prompt_async` acknowledges admission, not
completion. `message.updated` carries assistant terminal evidence; `session.status` alone does not
prove that a particular prompt completed. Native session deletion is not CCMux archive.


## Native Claude execution mode

Opt-in and off unless the host enables it, because the mode changes which authentication a
deployment leans on and that decision is the operator's. `claudeNativeRuntime` permits it and
`claudeNativeSdk` names the package root of the agent SDK to run it with — a path on the host, like
`codexBin` and `opencodeBin`, since only this project's own harness is embedded. `runtime.list`
reports both Claude modes and separates three answers that call for three different actions:
the CLI is not configured, the mode is not enabled here, or no SDK is present at the configured path.

Dispatch is keyed on the `(agent, runtime)` pair for this one pair alone. A native row must not
inherit the interactive provider: its pane scanner, menu answerer and transcript reader describe
something that does not exist for it, and its fork detector would start from a missing file and adopt
an unrelated conversation, mismatching the session's identity permanently. The native provider it
receives instead has none of those, so the heal pass leaves it alone by construction rather than by a
caller remembering a guard.

The conversation id is **pinned**, not discovered. The runtime accepts the id a conversation should
have, so the managed identity and the runtime's own are the same value and no pairing is stored. A
first start names the id; later starts resume it. Both ids are excluded from external discovery, so a
conversation this machine already drives is never offered for adoption.

Tool permissions arrive as answerable requests carrying the arguments the tool would run with, and
are answered through the same native response path the other runtimes use. They have no timeout: an
unanswered request leaves the session visibly `waiting-approval`, which a person can act on, whereas
a timeout that declined on its own would make a decision nobody made and record it as the operator's.
Interrupt uses the runtime's own interrupt so the writer survives and answers `accepted` or
`rejected`, which is what this project's interrupt contract requires.

The mode runs as Claude Code rather than as a bare agent loop: the product system prompt preset and
the user, project and local setting sources are all requested, so `CLAUDE.md` and the operator's
settings apply exactly as they do in a terminal session. Incremental output is enabled, and the
deltas are the transcript — the finished message and the terminal result repeat the same text, and
recording all three wrote every answer three times.

Model, effort and images are turn options here, exactly as they are for the other native runtimes.
The catalog is published by the session owner into `models.json` beside its status file — only that
process holds a connection, so a reader elsewhere would have to invent the list. A host that has
never held the runtime is asked directly instead: the read opens a connection whose prompt never
yields, requests the model list, and closes it, so no conversation is created and nothing is sent.
Without that, choosing a model — which precedes the create that would produce the first publisher —
closed a circle that could only be left by a command typed on the machine. The probe answers in
seconds, is taken once at a time and reused for minutes, and a published catalog is always preferred
to it. When it cannot be taken, the refusal names the command that publishes one, because a host
with no runtime to ask leaves the caller with something to do rather than something to know. A row's `model` is
the alias a caller selects with, not the remote transport id it resolves to, because that is the value a stored
selection carries. Effort levels are published per model from what the runtime reports: some models
accept five levels and some accept none, and `effortAccepted` refuses a level its row does not list.
The runtime reports no input modalities at all, so the catalog states `text` and `image` — a
text-only claim would make the control plane refuse an image the runtime accepts. Attached images are
resolved to base64 blocks in the owner process, where the bytes are allowed to be, and a turn whose
images do not all resolve fails rather than quietly asking a different question.

Effort is session-scoped, not per-turn: the runtime has no per-turn setter, only
`applyFlagSettings`, so the level applies from the turn that asked for it onward.

Session control is typed, not typed-in. The runtime names its own slash commands and a caller runs
one as a turn of its own: it travels through the same runtime mailbox a message uses, and
deliberately NOT through the chat ledger, because ledger delivery frames every message with its
sender attribution and a slash command carrying that prefix is no longer a command. The permission
mode a turn runs under is published and settable, applied between turns — changing it mid-turn would
move the boundary under a tool call already judged against the old one.

Context fill comes from the runtime's own measurement rather than a statusline scrape, and carries
the window it was measured against: a model's hard limit and a smaller compaction window mean
different things at the same percentage, and a scrape sees only one number.

History, compaction and fork are the shared context operations, served here by the transcript the
runtime writes — the source of truth for a conversation — rather than by the live content buffer,
which is a bounded window over recent items. Compaction is the runtime's own command on the path
above; its boundary is read from the record the runtime writes, not inferred from a token count
dropping. Fork is the runtime's own fork, admitted once through the shared ledger; the destination
continues the conversation the runtime created for it, so its identity is that id rather than the
pinned generation a first-start session uses. Rollback stays refused: the runtime will not un-say a
conversation.

Which account a session runs on and what it has spent are published and travel through the fleet
slice, because a limit belongs to an account rather than to a machine. What is carried is an
identity — never a token, a key, or the name of where either lives.

How full that account's plan windows are travels beside it, in one vocabulary over two runtimes
that agree on nothing but the percentage. Claude names its windows and leaves their length implied;
Codex numbers them and states the length — and a measured `primary` held a WEEK, so a window carries
its provider's own key AND the declared duration, with neither derived from the other. The set is
open: a live answer carried buckets the published types do not declare, so known windows are read by
name and anything else shaped like a window is carried under its own. Claude's push and its pull are
both consumed: the pull answers "how full is it now" and the push — including the refusal itself —
names one window and merges onto the reading rather than replacing it. Codex is asked on the account,
not on the thread, so a session that has taken no turn can still answer.

Three answers stay distinct, because collapsing any two of them tells an operator the plan is fine
when it may be exhausted: a filled window; no plan limit at all (an API key, Bedrock, Vertex); and a
runtime that does not publish the fact. A zero would read as an empty window in all three. The fleet
slice groups the sessions by account and reports one window per account rather than one per session,
since ten sessions on one plan share one budget and ten identical bars would be a wrong model.

File checkpoints are off unless a session asks for them. With them on, the runtime keeps a copy of
every file a turn modifies and a caller can preview or perform a rewind; the preview and the act are
answered by the same code, and a path the runtime refuses to restore is reported rather than counted
as success. This is the one place the project answers for the working tree and not only for the
conversation, which is why it is a decision somebody makes rather than a default somebody discovers.

MCP servers are readable and controllable per session: status, tool count and the runtime's own
error sentence. Their configuration is not read at all — the URL, headers and any token the host put
there have no business in a status projection.

Custom and native Claude command loops watch their input mailboxes and registry files. Notifications
received during a tick are retained for the next pass; shutdown releases a waiting loop immediately.
A one-second reconciliation covers missing filesystem notifications. Directory events compare
the exact input files' identities and timestamps: a coalesced notification can name a neighbouring
lock instead of the command on macOS. Unchanged inputs cannot wake their producer, even when status,
content or locks change. Provider event streams publish directly, without waiting for this loop.

No dialog kinds are declared, because none can be rendered yet. The runtime reads that as "cannot
display" and degrades the affected flows, which is honest; declaring a kind promises to render it,
and a declared-but-unrendered dialog parks until a deadline.
