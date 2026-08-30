# Native history and explicit context operations

Status: accepted for the native control package. Live release acceptance remains in the package task.

## Authority and effects

The native runtime is the conversation authority. A history reader uses the existing owner
connection; it never starts another server, resumes an unrelated conversation, admits input or
replays a tool. The native content stream is a bounded observation cache, not a transcript database.

The current control surface has separate history, fork and compact capabilities. Rollback is
explicitly unsupported: Codex's deprecated `thread/rollback` changes history without restoring files,
whereas OpenCode's native revert calls the workspace snapshot revert. Neither provides the same
safe semantics as a managed conversation fork. No hidden Git reset or workspace restore is added.

## Native history

Codex uses `thread/items/list` with the native cursor and descending native ordering. OpenCode uses
classic `session.messages`, not the different v2 durable-message projection. Its `before` parameter
is an opaque native cursor from `X-Next-Cursor`, not a message ID. In OpenCode 1.18.20 the v2 history
manifest excludes classic `SessionV1` message/part updates; changing readers would lose that history.

Pages are capped at 64 projected entries, 128 KiB total text, and 16 KiB per item. A native reply
still has the existing 2 MiB transport ceiling and a five-second deadline. Source pages containing
more parts than fit are explicitly reported as omitted, not advertised as fully returned. Inline
native image echoes are elided before the SDK JSON decoder; safe history references are resolved
from the existing retained attachment pins. Native paths, data URLs and unrecognized image pointers
never leave the owner. An unresolved native image remains an explicit omitted image.

Only assistant text, user text, model-provided reasoning summaries, and safe item lifecycle fields
are projected. Raw hidden reasoning, command text/output, tool arguments/results and private paths
are not copied into the public history response. Cursors bind the registration, native identity,
observer generation and context revision. A successful context mutation or observation restart
invalidates prior cursors. A mutation racing a native page read refuses the page instead of combining
two context revisions.

## Compact journal

States are `queued → dispatching → running → completed`; a lost ACK becomes `uncertain`, while
stale pre-dispatch admission becomes `rejected`. The operation UUID and observer generation are
immutable. The owner persists dispatch intent before the native compact call. New input, selection,
steer and fork cannot pass an unresolved compact operation; previously accepted queued input prevents
compact admission. The native admission lock is shared across processes, not only HTTP requests.

An empty ACK or an idle status is not completion. Current Codex emits canonical
`item/completed` with `contextCompaction` only after replacing compacted history; its App Server no
longer forwards the deprecated `thread/compacted` notification. OpenCode publishes `session.compacted`
after successful compaction and persists the completed summary assistant message. A new persisted
compaction marker can reconcile a missed completion after restart. No marker change means the
operation stays unresolved; the compact call is never retried blindly.

Journal revision changes also reset content replay. The journal has a fixed 256-operation budget;
accepted identities are never silently evicted to make room for a retry with the same UUID.
Automatic native compaction advances the same revision without fabricating a caller operation.
Exact completion identities deduplicate observations; retired observers cannot advance the revision.
One journal-owned publication callback handles both native events and restart reconciliation. It
durably flushes the content reset before publishing the completed operation/revision; a duplicate
event cannot reset replay again. Ordinary text publication remains coalesced.
Codex live compaction item IDs differ from reconstructed history item IDs, so completion events
resolve the persisted marker through the same owner connection before journal deduplication. A
marker equal to the pre-dispatch marker does not complete the new operation.

## Destination-owned fork

The public request identifies the exact source registration/observer generation and a destination
name/request UUID. Workspace, owner launch environment, immutable recipe/application policy and
effective selection are inherited explicitly by this same-workspace operation. Callers cannot
provide an executable, shell text, credential, arbitrary path, flags, model override or another
runtime. A changed source generation is rejected before a new operation; a late retry matches the
stored accepted operation rather than current defaults.

The existing create journal reserves the destination registration before spawning its native owner.
The destination-owned App Server performs Codex `thread/fork` with the captured last completed turn,
excluding response turns and deferring goal continuation. It does not fork on the source server and
then attach a competing writer. OpenCode forks through the destination's existing authenticated
native client while source input admission is held. Native fork supplies new message/part identities;
CCMux retains the existing safe image references for both branches.

OpenCode 1.18.20 native fork does not copy its session-level model/agent fields. After recording the
fork ACK, the owner uses the native typed config-only model/agent switch on the same session table,
then reads back the chosen model. These config operations do not wake the v2 execution loop. They
are idempotent; native fork is not. Subsequent restart uses current retained selection, not the
original fork defaults.

Fork intent is durable before the native call. A received native ID is saved before registration
promotion. Lost ACK remains `uncertain`, keeps its destination reservation, and cannot dispatch a
second fork. A received ACK followed by interruption resumes that same native ID. Policy/config
failure does not become permission to forget an admitted writer.

## Upstream evidence

- Codex `rust-v0.151.0`: `core/src/compact.rs`, `core/src/session/mod.rs`,
  `protocol/src/legacy_events.rs`, `app-server/src/bespoke_event_handling.rs`,
  `app-server-protocol/src/protocol/thread_history.rs` and `protocol/v2/thread.rs`.
- OpenCode `v1.18.20`: `packages/opencode/src/session/session.ts`, `compaction.ts`, `revert.ts`,
  `server/routes/instance/httpapi/handlers/session.ts`; `packages/core/src/session.ts`,
  `session/projector.ts`, `session/sql.ts`; `packages/schema/src/durable-event-manifest.ts`.

Focused tests cover native-only history projection, byte limits, cursor invalidation, stale completion,
compact lost ACK/restart reconciliation, accepted input exclusion, and one-fork admission/retry.
The integrated release must additionally prove real text/image history, fork continuation, compact
completion and restart on each supported native runtime through the published service.
