---
title: External session discovery and ownership
description: Provider-neutral identity, advisory writer evidence and atomic Codex adopt/fork/takeover boundaries
type: architecture
status: active
created: 2026-08-10
updated: 2026-08-10
---

# External session discovery and ownership

External inventory is a local, read-only projection. Its identity is
`external:<provider>:<host>#<threadId>`. Cwd, transcript path, mtime and persisted origin are display
metadata and never selectors. Managed rows use a separate plane key including provider, host,
registry name and UUID, so equal cwd or UUID fixtures remain independently selectable.

## Independent evidence

| Axis | Values | Meaning |
|---|---|---|
| storage | stored / missing / unknown | Whether a provider transcript was read. |
| origin | cli / desktop / vscode / exec / app-server / subagent / unknown | Immutable creation metadata, not the current writer. |
| writer evidence | observed / none-observed / unknown | Result of this poll. `none-observed` never means free. |
| runtime | dedicated CLI / Desktop / editor / App Server / shared / self / unknown | Best classification of positive process evidence. |
| admission | accepted / conflict | Result of the mutating managed process, never a discovery inference. |

Codex inventory is the union of persisted `session_meta` rollouts and positively held writer-lock
UUIDs. This exposes a pre-turn task whose rollout does not exist yet as storage missing + observed
writer, without inventing cwd or origin. A stale lock filename without an OS holder is not a live
item. `thread/list` loaded status and argv are enrichment only.

## Codex ownership transactions

Adopt reserves a pending generation, starts one ordinary process-TUI `codex resume <uuid>`, and
promotes the same UUID only after the exact lock is held by that spawned process tree. Conflict,
crash, timeout and CAS loss kill/erase only that generation; the daemon never retries a rejected
admission.

Fork reserves the same transaction but runs provider-native `codex fork <sourceUuid>`. Promotion
requires one rollout matching both the unique launch marker and provider-recorded
`forked_from_id`. The source rollout and writer stay untouched. The management prompt is a visible
first turn of the new fork; adopt-in-place adds no synthetic turn and therefore does not claim
managed chat/router capability.

Takeover is unavailable for Desktop, editor, App Server, shared, self and unknown runtimes. They
must release the thread at the source. A dedicated CLI requires a second explicit confirmation;
ccmux revalidates UUID, PID, start time and process group immediately before SIGTERM. PID reuse,
changed evidence or a respawn aborts or loses the subsequent atomic admission without registration.

External inventory itself remains read-only and does not grant takeover. A narrower capability now
exists for a Codex thread whose exact UUID is confirmed by an already-running App Server: it may be
addressed as `app/<uuid>` in the chat ledger. That endpoint is not a managed registry row and does
not imply lifecycle ownership, daemon healing or takeover rights.
