---
title: External session discovery and ownership
description: Provider-neutral identity, advisory writer evidence and atomic Codex adopt/fork/takeover boundaries
type: architecture
status: active
created: 2026-08-10
updated: 2026-08-27
---

# External session discovery and ownership

External inventory is a local, read-only projection. Its identity is
`external:<provider>:<host>#<threadId>`. Cwd, transcript path, mtime and persisted origin are display
metadata and never selectors. Managed rows use a separate plane key including provider, host,
registry name and UUID, so equal cwd or UUID fixtures remain independently selectable.

`ccmux external` reads that projection explicitly; `ccmux external --json` returns its strict
machine-readable shape. The command is local because the rows are observations, not lifecycle
promises. `list` and `fleet` remain managed-only. An explicit read performs the scan regardless of
the TUI's initial `externalInventory` preference, just as toggling the inventory on in the TUI does.

## Independent evidence

| Axis | Values | Meaning |
|---|---|---|
| storage | stored / missing / unknown | Whether a provider transcript was read. |
| origin | cli / desktop / vscode / exec / app-server / subagent / unknown | Immutable creation metadata, not the current writer. |
| writer evidence | observed / none-observed / unknown | Result of this poll. `none-observed` never means free. |
| runtime | dedicated CLI / Desktop / editor / App Server / shared / self / unknown | Best classification of positive process evidence. |
| turnState | working / idle / waiting-approval / waiting-input / unknown | Independent, expiring provider-native execution observation. |
| admission | accepted / conflict | Result of the mutating managed process, never a discovery inference. |

Codex inventory is the union of persisted `session_meta` rollouts and positively held writer-lock
UUIDs. This exposes a pre-turn task whose rollout does not exist yet as storage missing + observed
writer, without inventing cwd or origin. A stale lock filename without an OS holder is not a live
item. `thread/list` loaded status and argv are enrichment only.

## External turn observation

`ccmux external --json` adds a required `turnState` object to every row. The human command has a
separate `TURN` column. Writer locks, PID, origin, last message and activity age never select its
value. The synchronous ownership lookup used by adoption remains independent and starts with
`unknown/not-observed`; it does not wait for execution observation or change admission rights.

The execution reader connects only to the **existing** Codex App Server control socket under the
configured Codex home (`app-server-control/app-server-control.sock`). It does not start a runtime,
resume/subscribe a thread, read Desktop's internal IPC, or insert a turn. Stdio-only App runtimes,
missing sockets and other providers have no supported observation through this door. A positive
writer lock still does not allow them to claim a turn state.

The reader uses `thread/list` with `useStateDbOnly: true`, all supported source kinds, and exact UUID
matching. Native `status`, not inclusion in the loaded set, is authoritative:

| Native status | `turnState.state` |
|---|---|
| `active`, no flags | `working` |
| `active`, `waitingOnApproval` | `waiting-approval` |
| `active`, `waitingOnUserInput` | `waiting-input` |
| `idle` after completion or interruption | `idle` |
| `notLoaded`, `systemError`, missing or unsupported status | `unknown` |

Approval takes precedence if both waiting flags occur. Unknown active flags fail closed. Provider
protocols were verified at versions 0.144.6 and 0.149.0; an absent/unrecognized initialize user agent
or a version below 0.144.6 produces `unknown/unsupported-runtime` **without** a list request, because
older servers could ignore the no-scan option. See the [provider status protocol](https://learn.chatgpt.com/docs/app-server).

Each object carries `state`, `evidence`, `source`, `observedAt`, `expiresAt`, and a fixed `reason` code.
`source` is `codex-app-server` or `unsupported`; no raw RPC errors, messages or paths are copied into
it. Evidence is `observed` only for a known state, `unknown` for absent/unsupported state,
`unavailable` on connection/protocol failure, and `stale` on the observation deadline. Failures clear
all partial results for that read, never inheriting previous working state. A new connection reads
current status, including idle after interruption. Unknown evidence has nullable timestamps.

Receipt timestamps are not turn start/completion timestamps. Observations expire **5 seconds** after
receipt. Consumers must treat an expired observation as `state=unknown, evidence=stale`, even if a
cached inventory still contains `working` or `idle`; a recent activity timestamp cannot renew it.
There is no completed-result cache in the reader.

Per call: one connection, one request at a time, at most **4 pages × 128 entries**, **2 MiB** per RPC
message, **2 seconds total** including connection/initialization, 16 KiB handshake headers and 1,024
fragments maximum. Deadline or oversized input closes the socket. Unvisited identities are
`unknown/read-limit`, never idle. Native status observation spawns no CLI, tmux, or transcript scan;
the existing inventory's ownership/metadata discovery cost is unchanged. This is not a resident
replacement for the full external inventory scan, nor permission for consumers to parse transcripts.

Validation covers lifecycle mappings, shared writer independence, lost/reconnected/missing/stale
evidence, pagination and byte/deadline bounds. Real App Server verification created two isolated
test threads: both held by one shared writer while one was working and the other completed/idle;
interruption and reconnect returned idle while both locks remained observed. Test threads were
archived afterward. A separate 100-read native benchmark made exactly 100 list requests (about
33 ms median / 51 ms p95 on the measured host); discovery was performed once before the benchmark.

To repeat the live acceptance check against the **installed release**, run
`bun scripts/verify-external-turns.ts --run` on a host with an accessible App Server. This opt-in
script creates two new read-only test threads, verifies both exact identities through installed
`ccmux external --json`, observes working/idle under one shared writer, interrupts only its own
test turn, reconnects, and archives both test threads. It fails if the installed version differs
from the checkout or any lifecycle/ownership check fails. It never resumes an existing thread.

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
