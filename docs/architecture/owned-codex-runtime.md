---
title: Owned native Codex App Server runtime
description: Process ownership, identity, state, delivery, recovery and the resident reader contract for opt-in native sessions.
type: architecture
status: active
created: 2026-08-28
updated: 2026-08-29
---

# Ownership and admission

Create a new session with `ccmux new <name> <dir> --agent codex --runtime app-server`.
The existing `_bootstrap`/`_run` supervisor owns one native `codex app-server` process group
and its attached `codex resume --remote` terminal client. A launcher wrapper and native child
are one disposal unit; a killed wrapper cannot leave an orphan writer behind. There is no new
observer daemon, relay, account system or replacement inference harness. Each session has its
own provider environment, cwd, permission policy and existing managed chat capability.

The provider requires Codex CLI >=0.147.0 and advertised Unix App Server/remote-resume support.
Admission validates these before creating the pending registry entry. Model, sandbox and approval
flags are translated into native configuration; unknown routing/identity flags are rejected.
Authentication stays in the configured native Codex home. No credentials are copied to readers.

The provider mints the UUID. A fresh conversation receives an explicit, short initialization turn
so its rollout is durable before the registry promotion. Addressable chat is accepted only after
that exact UUID is committed to the existing pending/ready transaction. Resume always uses the
pinned UUID, never cwd, newest history, a picker or a fallback fresh thread. Missing history,
identity disagreement, or an already-owned endpoint blocks lifecycle rather than guessing.
`adopt`, `fork` and `renew` do not implicitly convert an existing thread to this mode.

The local endpoint is derived from the state-root/session identity and placed in a same-user
0700 directory under the platform temporary root. It is not the official Desktop control socket.
The same-user boundary is trusted; this is not isolation against another program running as
that user. Raw native clients can control their own turns and must not be treated as concurrent
CCMux delivery schedulers: the provider does not promise a conditional idle-to-start transaction.

# Native state and recovery

The observer subscribes before start/resume, buffers at most 128 admission events, then reconciles
the native snapshot with a revision guard. A response requested before a newer event cannot erase
that event. Each reconnect creates a new generation. Retired connections cannot publish or close
over a newer generation. Native turn events also feed the existing `ccmux events` stream; history
reconciliation does not replay old completion notifications.

| Evidence | Published state |
| --- | --- |
| Active, no wait flags | working |
| Active, waitingOnApproval | waiting-approval |
| Active, waitingOnUserInput | waiting-input |
| Native idle | idle |
| Not loaded, system error, unknown/malformed native state | unknown |
| Missing/dead/disconnected producer or identity mismatch | unavailable, no positive snapshot |
| Expired observation | stale, no positive snapshot |

Turn completion, interruption and failure remain distinct even when the next native thread state
is idle. An observed turn start carries its timestamp; historical starts not observed by this
connection remain null. The observer subscribes to bounded item boundaries and usage while
excluding unbounded deltas, catalogues and progress. It retains a separate native-item ring for
user/assistant/reasoning/tool items, numeric usage, terminal boundaries and exact approval/input
requests. Known text is clipped and the retained ring
has an independent byte budget; commands, output, cwd, diffs and arbitrary provider payloads never
enter the projection. Native RPC messages are capped at 2 MiB; oversized/invalid messages disconnect fail-closed.
Metadata reconciliation is at most once per 500 ms per session, not per reader. Reconnect backoff
is bounded at 500 ms..10 s. The only history reconciliation is a one-turn native summary at resume.

The provider process and interactive client survive a CCMux daemon restart. A lost observer
reconnects without restarting the writer. A provider crash terminates its owned process group
and resumes the same UUID with supervisor backoff. An explicit session stop/restart disposes the
client and provider, retaining native history. If the supervisor itself is forcibly killed and
an endpoint remains owned, the next supervisor refuses a second writer; it does not adopt an
unverified orphan. Resolve that exact endpoint owner before an explicit restart.

# Messages and acknowledgement

Existing immutable ledger records and provider + machine + session + UUID reply identities are
unchanged. The daemon waits for fresh native idle evidence, serializes delivery, gates the managed
terminal's input, and checks for a blank known composer. It then rechecks native admission and
registry identity. Menus, partial input, unknown UI, busy state, approval and input waits hold
delivery; no automatic approval or input response is sent. Spinner text is not native turn state.

Before `turn/start`, the immutable message ID is persisted as an intent. The native request uses
that ID as `clientUserMessageId`. Acceptance records the returned turn ID. The next pickup check
requires its terminal boundary or an exact persisted `userMessage.clientId` receipt. A timeout or
lost reply is ambiguous: the durable intent is held and reconciled, never blindly resubmitted.
Receipt lookup is bounded to 32 recent native turn summaries and the RPC byte limit. Absence is
not proof of rejection, so an unresolved intent stays held rather than producing duplicate work.

Immediate and conditional messages keep separate cursors. A conditional acknowledgement follows
pickup evidence, not the mere send attempt; future `--after` mail does not block an immediate reply.
`wait` requires native idle, a terminal/no turn, and no due unread mail or unresolved pickup.
It distinguishes interrupted from completed work; failed turns do not return success. `wait`
means between turns, not proof that a business task is fully complete.

# Resident contract

`ccmux runtime <name> --json` reads the prepared session snapshot. It does not connect to Codex,
capture tmux or scan transcripts. Exit codes are 0 live, 2 stale, 3 unavailable, 1 invalid usage.
Ordinary sessions are rejected. Remote selectors use the existing configured CCMux transport.

Import `readCodexRuntime` and `codexRuntimeUpdates` from `ccmux/codex-runtime-reader` in a Bun
consumer. Releases publish self-contained `codex-runtime-reader.js` and `codex-runtime-reader.sha256`;
verify both from the same immutable tag before importing the local asset. The exported
`CODEX_RUNTIME_READER_VERSION` identifies the library, independently of the producer version.

Input is strictly `{session, threadId, timeoutMs?, signal?}`. Session and UUID must come from
the managed inventory, never a title/cwd guess. Caller paths, commands and refresh options are
not accepted. Discovery/configuration follows the [monitoring reader](monitoring-status.md):
same configured OS user/root; configuration is read before and after the prepared file, and any
change returns `config-changed`. There is no old-root fallback. A later call follows the new root.

The protocol-1 envelope is `{protocol,status,reason,snapshot}`. A live snapshot preserves provider,
machine, session, threadId, generation, sequence, worker pid, provider pid, producer version,
connected, state, reason, observedAt, expiresAt, turn and a 128-entry event window. No message body,
environment value, credential or arbitrary filesystem path is returned.

Configuration and snapshot are capped at 128 KiB each. Readers use same-user regular files,
O_NOFOLLOW/O_NONBLOCK and reject group/world-writable files. The producer writes mode 0600 atomically.
Freshness is at most 5 seconds, checked again when delivering each result. Dead worker/provider
PIDs immediately invalidate positive state. A restricted reader receiving EPERM from a PID probe
does not mistake permission denial for death; its result is still bounded by the five-second
producer lease. PID reuse is also ultimately bounded by that lease, not process authentication.

Concurrent reads of the same identity coalesce one config/file/config batch. A library instance
allows at most 128 pending callers and 128 in-flight keys, with no queued work or completed-result
cache. Each caller receives its own data. Default timeout is 250 ms; allowed values 1..1000 ms.
Cancellation removes only that caller. A deadline never returns a late live result, including
event-loop delays. Stalled filesystem operations remain bounded and close when the OS completes;
the reader cannot interrupt a blocked JavaScript event loop or forcibly cancel an OS read.

`codexRuntimeUpdates` accepts an optional `CodexRuntimeCursor` and returns a reset/baseline on first read, unavailable state, generation change
or an event-window gap. Otherwise it returns only new events. Polling cadence belongs to the
consumer; imports create no timers, processes, provider connections or subscriptions.

The richer same-user control surface lives in `ccmux/control-client`. `create` uses the existing
pending/promotion registry transaction with an immutable request receipt and normalized workspace;
retries cannot create a second writer. `archive` retains the provider rollout and ready row while
stopping healing and the owned process group. `native` and `watchNative` expose the bounded item
projection with generation/sequence cursors and explicit resync. `respond` can answer only a current
exact approval/input request and forwards the response to the connection that received it. Restart
changes projection generation and invalidates old requests/cursors without changing the thread UUID.

# Interactive and Desktop boundaries

The selected interactive client is the native terminal CLI attached to the same App Server.
The official Desktop app is not automatically attached. Persisted history visible there is not
live coexistence. Existing Desktop tasks, application launch settings and private IPC are untouched.
This release supplies the owner runtime/reader contract, not another application's deployment.

# Verification and rollback

Regression tests cover native flags, exact identity, snapshot/event races, retired generations,
private/bounded files, cancellation/deadlines/root changes, coalescing, process-group cleanup,
composer gates, intent/receipt recovery and existing provider compatibility.

Real opt-in probes are `scripts/codex-owned-runtime-probe.ts`, `codex-owned-e2e.ts`,
`codex-owned-safety-probe.ts` and `codex-owned-recovery-probe.ts`. They require isolated state and
tmux, create only new test conversations and use the operator's configured native authentication.
They spend provider usage and must be explicitly run, not included in unit tests. The last three
take the first probe's configuration path and an optional released CLI bundle path. No public
task or release notes should contain their private raw configuration, transcript or host output.

Rollback keeps the ordinary TUI path unchanged. Before downgrading to a version without this mode,
archive and stop the exact native sessions and retain their registry/history. Older versions do not understand
the runtime field and must not auto-heal those rows as ordinary CLI writers. Upgrade again and
explicitly start the same rows to resume; never rename or regenerate their UUIDs.
