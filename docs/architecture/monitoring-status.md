---
title: Resident managed-session monitoring status
description: A bounded local snapshot from the daemon observation loop, with no per-reader transcript or pane scans.
type: architecture
status: active
created: 2026-08-27
updated: 2026-08-27
---

# Monitoring status

The daemon's existing session observation loop owns this projection. It captures each running
managed pane once per pass, maintains lifecycle evidence, and atomically publishes a compact
snapshot. It is not another supervisor or mutable session registry.

## Reader contract

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
  Each read opens one nonblocking, nonsymlink regular file and reads at most 512 KiB plus one
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

Rollback uses ccmux update --rollback. Existing managed sessions outlive the daemon bounce.
An older producer does not publish this surface; callers receive unavailable/stale rather than
falling back to an expensive scan. There is no implicit consumer-side fallback.
