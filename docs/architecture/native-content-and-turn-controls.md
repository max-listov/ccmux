---
title: Native content and turn controls
description: Current image, content replay, selection, steering and context contracts for managed native sessions.
type: architecture
status: active
created: 2026-08-30
updated: 2026-08-30
---

# One current control surface

The local client and injected-fetch service client call the same domain operations. The service
uses the unversioned prefix `/ccmux/control`, ingress `/ccmux-control/invoke` and native stream
profile `ccmux-native`. The required service-envelope revision is the literal `current`, not a
version-negotiation mechanism. Numbered routes, content shapes and client profiles are not
translated or kept alive. Native provider adapters
are different implementations of those operations, not compatibility clients.

The managed registry is the identity authority; provider history is the transcript authority.
All turn mutations share native admission with daemon pickup. An accepted message is the existing
durable chat ledger entry, never another provider queue. Registration, native generation and exact
turn/request identities have separate purposes and are checked at their operation boundaries.

| Operation | Codex App Server | OpenCode native server |
| --- | --- | --- |
| PNG/JPEG input | Local image input, model modality checked | File input, model modality checked |
| Content | Assistant deltas, public reasoning summaries, lifecycle | Assistant deltas and lifecycle; raw reasoning excluded |
| Defaults/per-turn options | Model, Plan/default, effort | Model, advertised primary agent, variant |
| Steering | Exact `turn/steer` expected-turn CAS | Unsupported: no equivalent native CAS |
| History | Bounded `thread/items/list` | Bounded classic messages and native pagination header |
| Fork | Destination-owned `thread/fork` | Native fork plus same-writer model assignment |
| Compaction | `thread/compact/start`, completed compaction item | Native summarize, completed summary marker |
| Rollback | Unsupported | Unsupported; no conversation/workspace safety equivalence |
| Application policy | Owner instructions and native skill inputs | Owner canonical native agent, deny-only tool policy |

Native ownership requires Codex 0.151.0 or newer and OpenCode/SDK 1.18.20. Runtime capability
booleans describe the operation, not account readiness or every model's modalities. Claude remains
interactive; Custom remains unavailable pending its published optional harness dependency.

# Selection and input

`create.modelSelection` is immutable create-time identity. `selection({target,registrationGeneration})`
reads persistent `current:{revision,options}`; `select` also takes `operationId,expectedRevision,options`.
Changes refuse busy turns, pending requests, unresolved context work and accepted queued messages.
They do not alter credentials, sandbox or approval authority.

`message({target,messageId,body?,images?,options?})` pins options at acceptance. Its receipt includes
`turnOptions`; retries return those original options even after defaults change. An explicit override
affects that message only. Later ordinary messages pin the persistent default again.
Status and content expose `selection` as accepted future defaults and `nativeSelection` as separately
observed configuration: native admission/settings, an actual assistant record, or model rerouting.
A desired value is never reported as native-effective merely because it was written locally.

Images use `attachmentBegin → attachmentChunk → attachmentFinalize`, then immutable references in
message/steer input. Preview is `attachmentRead`; cancellation only deletes unretained bytes.
No public image field accepts a path, URL or Base64 turn payload. PNG/JPEG decoding, quotas,
caller/registration authorization and retention are specified in the
[attachment decision](../decisions/2026-08-30-managed-image-attachments.md).

# Content replay

`native` and `watchNative` return the same frame. `records` are cursor-relative updates;
`baseline` is an authoritative bounded replacement only when `reset` is non-null.
Generation/sequence bind the observer epoch. Reset is `initial`, `generation`, `gap` or `context`.
Consumers deduplicate by sequence; `replace` starts an item revision, while `append` uses its byte
offset. `prefixKnown`, `omittedBytes`, `totalBytes` and `complete` distinguish observed text from
truncated or missed prefixes. Terminal lifecycle completes a turn; EOF never does.

The cache retains 512 records within 192 KiB replay, 64 baseline items within 192 KiB, 64 KiB text
per item and a 512 KiB serialized snapshot. Each text record is at most 4096 bytes; UTF-8 boundaries
are preserved. Request/terminal baseline entries receive retention preference during text floods.
There are at most 32 readers with one coalesced notice each, a 50 ms write interval and shared
filesystem watchers and a shared one-second lease check. A stable notification inode is updated only after atomic snapshot publication.
Readers add no provider connection, token queue, transcript poll or observer pass.

Native admission commits its initial identity-bound content baseline before enabling live status
callbacks. Subsequent token updates remain coalesced; a failed initial write refuses readiness.

Lease/settings-only updates retain the same content cursor but publish refreshed metadata. Native
Plan deltas and completed Plan items use the assistant-content kind. Completed native items reject
late nonterminal updates even when their retained baseline is explicitly truncated. On reset, clients
also process terminal/request entries in the baseline; those outcomes need not appear again as deltas.

OpenCode's own image echoes are bounded/elided before SDK JSON allocation. Non-image JSON budgets
remain unchanged; native user image references are joined to existing authorized pins for history.
Neither raw reasoning nor tool inputs/outputs, errors, local image paths or credentials are public
content. Explicit omissions are not described as a complete transcript.
OpenCode native `synthetic` text and internal compaction-summary text are not authored conversation
content. History keeps their metadata with explicit omitted-byte counts; public live content omits
them. This is native-metadata selection, not text-pattern sanitization of user or assistant messages.

## Tool observations

`ContentRecord.tool` and `NativeHistoryEntry.tool` share the exported `ToolObservationSchema`:
`{callId, name, lifecycle, outcome, exitCode}`. Absent observation is `null`; absent call/name/exit
evidence is separately `null`. Names are bounded to 128 characters, call IDs to 256. Lifecycle is
`pending | running | completed | unknown`; outcome is
`unknown | succeeded | failed | interrupted | declined`. Nonterminal observations cannot claim
an outcome or exit code. `complete`, outer `status` and a completed parent turn do not imply success.

Codex command exit codes, explicit native failure/decline/interruption and dynamic-tool success
flags are authoritative. Native completed file changes and completed MCP calls with a result carry
their provider-defined success semantics. Other completed items without result evidence remain
unknown. OpenCode preserves the native tool name and explicit error/interruption metadata; `bash`
exit codes distinguish success from nonzero exit even when its native lifecycle is completed.
Generic OpenCode completion without structured result evidence remains unknown. Output/error text
is never parsed to manufacture an outcome, and arbitrary result bodies/metadata are not published.

`itemId` remains the native item ID: the Codex item ID or OpenCode part ID. `tool.callId` is the
separate call identity (OpenCode `callID`); consumers must not equate a part with a call or turn.
Live observation and native history use the same provider mapper. Bounded replay/baseline retain
the complete typed observation. Duplicate or late nonterminal/unknown updates cannot erase known
terminal evidence; changing a known call identity on the same item is refused. History cannot infer
a lifecycle event it did not observe when the native stored item supplies no status.

Both published clients and native stream serialization use these same schemas. The existing
26-operation descriptor and `current` revision remain; there is no new route, alternative stream,
compatibility adapter, provider reader or writer. See the
[tool observation decision](../decisions/2026-08-30-native-tool-observation-outcomes.md).

# Steering and context

## Approval scope and cancellation

Pending requests contain nullable `scope: PermissionScope`. Supported OpenCode filesystem
permissions expose `operation`, `kind: filesystem-patterns`, and separate `requested`/`session`
sets, each `{patterns, omitted, complete}`. The first is the immediate permission; the second is
the native `always` grant used by `acceptForSession`, which may be wider. Each set retains at most
eight unchanged patterns of at most 1024 UTF-8 bytes. Oversized/control-character patterns are
omitted, never shortened into a misleading narrower path. Missing fields and omissions mean
incomplete context. Non-filesystem permissions (including shell commands) and Codex approvals
without a supported resource projection have `scope: null`; UI must say context is unavailable.
Raw command/input/diff/error/metadata bodies are not public approval scope. This display context
does not itself authorize anything or relax host policy.

`interrupt({target,generation,turnId})` cancels exact in-progress computation or suspended
approval/input through the existing writer. Stale generation/turn and unknown/idle states refuse.
OpenCode persists intent before abort, checks again after yielding to native events, and does not
replay an uncertain abort. Terminal evidence retires only that turn's pending requests, including
when native abort emits no separate permission-resolved event. Late requests for a terminal turn
are ignored. No permission is accepted and no conversation is archived by cancellation.

`steer` binds target, registration, generation, expected turn and operation UUID. It uses a durable
intent before the native call and `steer:<operationId>` as its native message identity. This prevents
collision with ordinary queued messages. Lost ACK means uncertain; an exact native receipt can
prove acceptance, but no automatic resubmission is allowed. Pending approval/input and partial
human input refuse steering. Ordinary messages continue to wait for idle.

`history({target,registrationGeneration,limit?,cursor?})` requests a bounded page through the existing
owner connection, not a new writer. The cursor binds registration, native identity, observation
generation and context revision. Limits are 64 entries, 128 KiB text/page, 16 KiB/item and 5 seconds;
omissions and completeness are explicit. Stale context cursors refuse rather than skip silently.
History/context work runs in one cancellable background owner pump, leaving heartbeat and native
approval/input RPC usable during a stalled read. A cancelled Codex context read keeps its single
native RPC slot until the outstanding reply settles; repeated cancellations cannot accumulate
unbounded RPCs or close the shared writer. Late replies cannot complete a cancelled operation.
Image references follow the native history input order, including repeated references, rather than
the attachment pin insertion order.

`compact({target,registrationGeneration,generation,operationId})` accepts only idle, unblocked
context. `contextOperation` reports queued/dispatching/running/completed/uncertain/rejected.
Native completion markers, not ACK or idle, complete it. Uncertain mutations block new turns.
Context reset must be published before a completed receipt becomes visible.

`fork({target,registrationGeneration,generation,requestId,name})` has no caller workspace/model/env
override. It inherits the same workspace, immutable launch authority/policy and accepted selection,
reserves its destination first, invokes native fork once and retains source attachment reachability.
The source remains unchanged. A lost uncorrelated fork reply stays uncertain; retry cannot create
another native conversation. Restart and late retry use the accepted create bytes and identity.

Runnable isolated acceptance scripts are `native-image-steering-acceptance.ts`,
`native-context-acceptance.ts`, `native-policy-acceptance.ts`, `native-selection-acceptance.ts`
`native-content-acceptance.ts`, `native-tool-observation-acceptance.ts` and
`native-approval-cancellation-acceptance.ts`
under `scripts/`. They require existing native account access, not caller-supplied credentials.
