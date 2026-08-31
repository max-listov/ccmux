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

Claude retains its interactive provider and truthful pane-based capabilities. Codex uses App Server.
OpenCode uses the native SDK/API and SSE. A custom driver composes a published optional harness;
it does not implement an inference loop, tool scheduler, product prompts or credential routing.
Capabilities are explicit per driver. An unavailable driver or unsupported operation is rejected
before registry mutation. Cross-machine transport dispatches the same typed control operations.
Custom is configured only when the execution host defines a Custom launch recipe. The working-tree
adapter composes `stitchkit@0.70.1`; it is not yet released because sequential signed approvals hit
a reproduced upstream history defect. Configuration availability is not release acceptance.

Prepared native projections are bounded in bytes, events and requests, leased by observation time
and tied to producer liveness. Native identifiers, selected model/provider and runtime version are
evidence; launch secrets and provider error payloads are not public metadata. Exact generation and
request identity gate approval/input responses. A stale response must not resolve a new request.

## Public use and limits

`client.runtimes({})` / declared-service `runtime.list` returns runtime availability and capabilities.
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

[T3 Code](https://github.com/pingdotgg/t3code/tree/1f8ed54add4133ac39effceded8fc1fff12d8e03)
separates its provider registry, owned-server lifetime and native continuation cursor. Its OpenCode
adapter handles prompt-admission races and correlates assistant messages with native parent IDs.
CCMux uses those ownership principles, not its UI, orchestration framework or application loop.

[OpenCode 1.18.20](https://github.com/anomalyco/opencode/tree/7248bc1964b13fa67e601733f89ee9dc6dfa0563)
provides authenticated HTTP control and structured SSE. `prompt_async` acknowledges admission, not
completion. `message.updated` carries assistant terminal evidence; `session.status` alone does not
prove that a particular prompt completed. Native session deletion is not CCMux archive.
