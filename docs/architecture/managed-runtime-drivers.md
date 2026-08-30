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
modify a production registration. The custom runner is deliberately not claimed runnable until its
published dependency and acceptance are available.

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
