---
title: Resident managed-session monitoring status
description: A bounded local snapshot from the daemon observation loop, with no per-reader transcript or pane scans.
type: architecture
status: active
created: 2026-08-27
updated: 2026-08-28
---

# Monitoring status

The daemon's existing session observation loop owns this projection. It captures each running
ordinary managed pane once per pass, maintains lifecycle evidence, and atomically publishes a compact
snapshot. It is not another supervisor or mutable session registry.

Opt-in [owned Codex App Server sessions](owned-codex-runtime.md) instead supply a prepared native
snapshot from their existing session supervisor. The daemon does not capture their pane for turn
state or create another provider observer. Native approval/input waits map to the existing `prompt`
state here; the per-session native reader preserves their distinct states. A live native producer
can prove a running session even where the caller cannot inspect tmux; missing uptime stays null.

## Native resident reader

For pushed snapshots and exact-session commands, use the separate [local control API](control-plane.md).
It consumes this same observation pass and preserves native approval/input distinctions. File-reader
protocol, bounds and discovery below are unchanged.

Import `readMonitoringStatus` from **ccmux/monitoring-reader** in a Bun application. Pin the
package to a release tag and bundle this library into the consumer; no CLI or installation
checkout is imported. GitHub releases also publish a self-contained `monitoring-reader.js`
ESM library and `monitoring-reader.sha256`. Download both from the same immutable versioned
release, verify the SHA-256, and import the local JS file. `MONITORING_READER_VERSION` identifies
the library; `snapshot.version` independently identifies the running producer. The library is
a consumer dependency, not another service and not something the daemon updater executes.

```ts
import { readMonitoringStatus } from "ccmux/monitoring-reader";

const result = await readMonitoringStatus({ timeoutMs: 250, signal: stop.signal });
if (result.status === "live" && result.snapshot) {
  render(result.snapshot); // replace the entire inventory; use provider + address + UUID
} else {
  showUnavailable(result.status, result.reason); // never retain old rows as live
}
```

`examples/monitoring-reader.ts` is an executable resident loop with signal cancellation.
The API accepts only `timeoutMs` and `signal`. Unknown options (including path, command and
refresh) return unavailable/invalid. Importing the module starts no process, observer or timer.
There is no registry read, tmux call, transcript read, shell or expensive fallback.

### Discovery, authorization and reconfiguration

The owner library, not the consumer, resolves the location. It reads the same `CCMUX_CONFIG`
selection as the daemon (default `~/.config/ccmux/machine.json`), taking only stateDir and
rcPrefix through the shared owner schema/resolver. With no config file, defaults apply:
stateDir comes from `CCMUX_STATE_DIR`, otherwise absolute `XDG_STATE_HOME` plus `ccmux`,
otherwise `~/.local/state/ccmux`; rcPrefix is `local`. A nonempty `CCMUX_RC_PREFIX` overrides
the configured prefix. No provider executable detection or full launch configuration is needed.
These are launch environment settings, never request options or returned environment values.
Daemon and consumer must run with the same selected configuration and OS user.

Every I/O batch reads configuration, the fixed `monitoring-status.json`, then configuration
again. A changed configuration/selection returns unavailable/config-changed without a retry.
The next call follows the new root; it cannot fall back to the old root. A new root without a
snapshot is unavailable/missing. The prefix must match the snapshot identity. Module-level
XDG/state defaults are captured at process startup, like the daemon: changing those launch
settings requires restarting the relevant process; edits to machine.json are picked up live.

Both files must be same-user regular files, not symlinks or FIFOs, and must not be group/world
writable. Reads use O_NOFOLLOW and O_NONBLOCK and close their handles in finally. Configuration
is capped at 128 KiB, the snapshot at 512 KiB, each plus one overflow-detection byte. Invalid
JSON/schema, excessive bytes, access failure or unsafe ownership/mode fail closed. The directory
and configuration are trusted owner-controlled local state, not a sandbox against the same UID.

### Deadlines, cancellation and bounded concurrency

- Default deadline: 250 ms; allowed timeoutMs: 1..1000 ms. Time is measured monotonically.
  Expired calls return unavailable/deadline, including when the event loop delayed delivery.
  JavaScript scheduling is not hard real-time: an unresponsive consumer event loop cannot be
  interrupted by this library, but a result past its deadline is never delivered as live.
- An aborted signal returns unavailable/cancelled and removes that caller immediately. It
  never cancels the daemon, another reader or a supervised session.
- One filesystem read batch is in flight per loaded library instance. Overlap is coalesced,
  with at most 128 callers; excess calls return unavailable/busy. There is no request queue.
  Each caller receives its own result data; one consumer cannot mutate another's snapshot.
- There is **no completed-snapshot cache**, polling timer or retained history. A cancelled or
  expired caller is removed from the bounded set, not left attached to a pending I/O promise.
  If a local filesystem operation stalls, only that single bounded batch remains in flight;
  later calls can time out but never create additional I/O batches. Handles close when the OS
  operation completes. This interface is intended for local filesystems, not remote mounts.
- PID liveness and freshness are rechecked at delivery. SIGKILL leaves a file but not a live
  result; graceful shutdown removes it. Generation/sequence and every row identity are preserved.
  Liveness is an observation at delivery, not a future lease. As with the CLI, PID reuse is
  ultimately bounded by the ten-second observation expiry; this is not process authentication.

Additional native reasons are unauthorized, config-changed, cancelled, deadline and busy.
All share the existing protocol-1 envelope and have snapshot=null. No private error details,
configuration contents, arbitrary paths or transcript bodies are returned.

## CLI reader contract

Run **ccmux status --json**. No selector, path, shell, refresh or mutation flag is accepted.
The command reads the fixed monitoring-status.json under the configured state root. The reader
does not start the daemon, launch a session, read the registry, open transcripts or invoke tmux.
Existing list, fleet, external and transcript commands retain their contracts.

The schema lives in src/monitoring/schema.ts. The result envelope has:

| Field | Meaning |
| --- | --- |
| protocol | Integer 1, independent of the application version |
| status | live, stale, or unavailable |
| reason | null when live; otherwise a bounded reason code |
| snapshot | Valid fresh snapshot, otherwise null |

Exit codes: 0 live, 2 stale, 3 unavailable, 1 invalid command arguments.
A missing/invalid/oversized file or dead producer is unavailable. An observation older than
10 seconds, or dated in the future, is stale. Failure never masquerades as an empty live fleet.
Consumers must branch on status, not infer availability from an empty session array.

Snapshot fields are protocol, producer version, boot generation UUID, monotonic per-generation
sequence, producer pid, rcPrefix, scope (managed), observedAt, generatedAt,
refreshDurationMs, maxAgeMs, limits, omitted and sessions.
observedAt is the start of the observation pass, not the instant a reader fetched it.
Generation changes on daemon restart; sequence alone is never a durable cursor.

Each row carries:

| Field | Meaning |
| --- | --- |
| plane | Always managed |
| name, agent, uuid | Registry name, explicit provider and pinned conversation identity |
| address | Full host:session selector; identity also includes provider and UUID |
| rc | Remote-control display label, not a routing selector |
| dir | Declared launch directory from the registry, not a measured current process cwd |
| archived, running | Registry lifecycle intent and observed tmux presence |
| state | working, idle, prompt, stopped, blocked, or unknown |
| model | Raw provider transcript model ID, or null |
| contextPercent | Hook metrics, then pane context; unknown is null, never invented zero |
| uptimeSeconds | Age of the observed tmux session at observation, or null |
| lastActivityAt | Transcript file modification time, or null |
| turnStartedAt | Lifecycle start of the current working turn, or null |
| observedAt | Time this row was projected |

No transcript message, prompt text, environment value or launch configuration is returned.
The usual working-state resolver and turn-evidence rules still apply. A failed capture is
unknown, not idle; a tmux inventory failure prevents publishing a new generation of observations.
An absent tmux server is positive evidence of no running managed panes.
External App/CLI threads remain in the separate external inventory. Their writer evidence is not
a managed lifecycle promise and is never relabelled as one in this snapshot.

## Bounds and lifetime

- Maximum 256 rows and 512 KiB snapshot bytes. Rows exceeding a field or total byte limit are
  omitted with an explicit count. Invalid or omitted data is not silently truncated into identity.
- One producer pass in flight; the next starts two seconds after completion, with no queued
  catch-up work. Observation subprocesses are serial, each with a one-second deadline and
  64 KiB per-output-stream cap. A slow pass expires honestly rather than promising fresh data.
- Each transcript metadata cache has a 1 MiB accounted payload/key budget and 512-entry cap.
  Accounting includes UTF-16 serialized payload, keys and fixed per-entry overhead; it is not a
  promise about total JS heap/RSS. The monitoring path uses the last-message and model caches.
  File device/inode, size, mtime and ctime invalidate replacement, rotation and truncation.
- Transient transcript reads retain the existing bounded windows: 512 KiB for last-message
  evidence, up to 4 MiB for model metadata. Raw history is not retained in the snapshot.
- The producer has zero in-flight reader requests: readers open an atomic file independently.
  Each snapshot read opens one nonblocking, nonsymlink regular file and reads at most 512 KiB plus one
  overflow-detection byte. Cancelling a reader cannot cancel the producer or a supervised session.
- Every publication replaces the complete row set; removed rows disappear on the next pass.
  Old rows are never returned once freshness expires. Daemon shutdown removes its live snapshot;
  abrupt death is detected by producer liveness or the freshness deadline.

## Verification and rollback

The monitoring-status tests check limits, identity replacement, stale/unavailable state,
working/idle/prompt/unknown/stopped evidence and metadata-cache rotation. The bundled CLI tests
exercise concurrent readers, large pipe output and cancellation without invoking the configured tmux.
The isolated real-daemon test uses its own tmux socket: transcript replacement, session stop/start,
daemon restart with a new generation, and registry removal all reach the reader. Daemon shutdown
leaves the supervised pane alive. Its non-UTF-8 locale also covers boot-service execution.
Run bun scripts/monitoring-bench.ts 900 for a 15-minute real-pane observation/read workload using an
isolated archived registry copy, so it does not heal sessions or emit lifecycle events.
It reports producer and observation-child CPU, reader CPU including children, exec counts,
latency, freshness and sampled RSS. The temporary config/results are local, never publication data.

Run `bun scripts/monitoring-native-bench.ts 900` for the native 15-minute resident workload against
the existing daemon, without starting an observer. It begins with 100 sequential and 100 concurrent
reads, then reads twice per second. Subprocess entrypoints are instrumented to throw and counted;
any read failure aborts the benchmark. Samples use fixed rings and periodic GC, reporting native
reader CPU, latency, freshness, heap/RSS and zero retained snapshot cache entries.
Native regression coverage includes stuck I/O with repeated timeouts/aborts, capacity, config
changes mid-read, root migration, schema/size/permissions/symlink/FIFO failures and result isolation.
The real isolated daemon test reads through the native API, survives graceful restart and SIGKILL,
and proves cancellation/restart leave the supervised pane alive. The release-asset test loads the
self-contained library offline outside the checkout and performs 100 concurrent native reads.

Rollback uses ccmux update --rollback. Existing managed sessions outlive the daemon bounce.
Bundle replacement and rollback share an owner-aware filesystem lock. Reinstalling identical
bytes does not replace the predecessor backup; backup failure aborts installation.
An older producer does not publish this surface; callers receive unavailable/stale rather than
falling back to an expensive scan. There is no implicit consumer-side fallback.
