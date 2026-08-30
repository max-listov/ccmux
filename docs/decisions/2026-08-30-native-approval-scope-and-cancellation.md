---
title: Native approval scope and exact suspended-turn cancellation
description: Preserve informed permission context and cancel without accepting a suspended request.
type: decision
status: accepted
created: 2026-08-30
updated: 2026-08-30
---

# Decision

Pending approvals carry a nullable typed scope. For OpenCode filesystem permissions, retain native
immediate patterns separately from native session-grant patterns. Limit each set to eight unchanged
1024-byte UTF-8 patterns; omitted/absent context is explicit. Discard control-character patterns
instead of rewriting them into apparently narrower permissions. Do not expose arbitrary metadata,
tool bodies, shell commands, diffs or secrets. Unsupported scope remains null, not inferred from
assistant text or caller intent.

Interruption requires caller-supplied native generation plus exact turn identity. Active computation,
approval suspension and input suspension are all cancellable; idle, unknown, stale or different-turn
evidence refuses. The owner uses its existing native connection. OpenCode intent is persisted before
the abort; identity is rechecked after persistence yields to events. A lost acknowledgement remains
uncertain and is not replayed. A retained accepted receipt makes an exact repeat harmless.

Native terminal evidence retires pending requests for that exact turn. This is necessary because
OpenCode's permission cancellation finalizer removes its request without emitting a separate reply
event. It is not permission acceptance or a fabricated decision. Later requests for a terminal turn
are ignored. Codex retains its native expected-turn interrupt check and now permits its observed
waiting-on-approval/input flags.

# Consequences and verification

The one current `turn.interrupt` contract requires `generation`; update callers rather than add an
alias or generation-less fallback. Both typed clients and packed consumers use the same schema.
Cancellation acknowledgement does not itself prove terminal completion; consumers observe the
exact message operation/native terminal event. No conversation is archived or recreated.

Golden tests cover missing/bounded scope, different immediate/session grants, stale identities,
late requests, settlement races, duplicate abort and lost acknowledgement. Real isolated public
client tests cancel narrow and broad external-write requests before any write, cancel a native
input request, verify pending removal and complete another turn on the unchanged identities.
