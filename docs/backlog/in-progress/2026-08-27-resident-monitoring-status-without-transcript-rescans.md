---
title: Resident monitoring status without per-reader transcript rescans
description: Serve a bounded authoritative status snapshot without restarting list aggregation for every monitoring read.
type: task
status: in-progress
created: 2026-08-27
updated: 2026-08-27
priority: P1
---

## Why

`src/commands/list.ts` builds list rows using transcript message/activity, lifecycle state,
context and tmux pane capture. Its process-local scan cache does not survive the next CLI
invocation. A periodic monitoring consumer needs a small status DTO, not transcript text or
another complete UI aggregation. The cost multiplies with independent readers.

## Result

Reuse the existing daemon/status authority where possible. If no suitable released read exists,
declare one fixed bounded resident status surface, not a second supervisor or mutable registry.
The owner chooses and documents the actual API; no consumer-specific name or configuration.

## Contract decision

`ccmux status --json` reads one bounded, atomically published local snapshot produced by the
existing daemon observation loop. It never starts a daemon, captures a pane or opens a transcript.
The snapshot is managed-only, like `list`; external inventory retains its separate ownership/API.
Protocol version, producer version, boot generation, sequence, per-row observation time and
freshness distinguish live data from stale or unavailable data. Fixed limits bound rows, bytes,
cached metadata and subprocess deadlines. Unknown evidence stays unknown, not idle or zero.

## Plan

- [x] Trace daemon, lifecycle/status files, provider-native state and actual list entrypoints;
      benchmark cold CLI and any existing resident read before adding an API.
- [x] Define version/generation/observedAt, limits and stale/unavailable outcomes. Preserve
      name/identity, state, model|null, context percent|null, uptime, activity timestamp|null
      and declared working directory semantics; never include transcript message bodies.
- [x] Move reusable expensive refresh to the producer; reading a snapshot does not capture
      panes or rescan transcripts again. Provider-specific managed/external ownership survives.
- [x] Bound snapshot bytes/items/omissions, cache bytes, in-flight reads and refresh scheduling.
      No caller-selected path or shell, arbitrary transcript access, or implicit session mutation.
- [x] Test live/idle/prompt/stopped/unknown, new sessions, provider restart, transcript rotation,
      absent daemon and cancelled reads. A monitoring read never starts a daemon or session.
- [ ] Run project gates, document the exact consumer contract, release and verify owned runtimes.

## Acceptance

- [x] Two simultaneous readers reuse the same observation; no per-read tmux/transcript subprocess.
- [x] Existing CLI semantics and all supported provider identities remain correct; unknown values
      are not fabricated as zero/idle. Removed sessions do not survive in a stale cache forever.
- [x] At least 100 sequential/concurrent reads and a 15-minute workload window report CPU
      including children, exec count, latency and freshness. Cache memory has a declared byte cap.
- [x] Restart/shutdown/cancellation is bounded and does not terminate supervised sessions.
- [ ] Exact released version/artifact, running-byte verification, rollback and consumer DTO are
      recorded before closing the task. No private identifiers appear in docs/tests/evidence.

## Что сделано

- [x] Producer: src/commands/daemon.ts and src/events/observe.ts share one observation pass;
  src/monitoring/project.ts and publish.ts publish an atomic managed-only projection.
- [x] Contract: src/monitoring/schema.ts, read.ts and src/commands/status.ts implement the bounded
  read-only API, version/generation/sequence, exact routing identity and explicit unavailable state.
- [x] Bounds: src/monitoring/tmux.ts limits child duration and output; src/util/mtimeCache.ts limits
  retained metadata and invalidates inode/size/mtime/ctime changes.
- [x] Regression evidence: test/monitoring-status.test.ts, monitoring-cli.test.ts and
  monitoring-daemon.test.ts cover states, caps, concurrent/cancelled reads, real isolated tmux
  lifecycle and transcript replacement. Full typecheck/test gate: 694 tests passed, zero failures.
- [x] Documentation: docs/architecture/monitoring-status.md defines the consumer DTO and rollback;
  docs/VISION.md and docs/architecture/tui-and-dev-flow.md link the resident monitoring surface.
- [x] Baseline: released cold list CLI used 0.20 s wall, 0.22 s user + 0.06 s system CPU including
  children, 159,039,488 bytes maximum RSS. Version 0.39.7 had no resident status command.
- [x] Local staged-runtime proof: live snapshot, 14 managed rows, no omissions. Rollback restored
  the exact prior bundle SHA-256 c2ba3a56b966cae0b10799d13e01583bee634adcf57ec73aa3ad833cc6c6ee11;
  reinstall restored live observations. Managed tmux identities and creation times were unchanged.
- [x] Installed-runtime comparison, 100 sequential CLI invocations per command: list consumed
  20.31 s wall and 28.74 s user+system CPU including children; status consumed 6.45 s wall and
  7.25 s CPU. Maximum child RSS was 161,136,640 versus 65,863,680 bytes. This is about 4x less
  per-reader CPU on the measured 14-row workload, not a universal performance claim.
- [x] Live registry parity: list and status returned the same 14 provider/UUID/name identities;
  status reported zero omissions. Raw names, paths, transcripts and local probe files stay private.
- [x] Verification safety: test/log.test.ts imports the real logger in isolated child processes.
  Its rotation fixtures cannot resolve to a previously cached production state path.
- [x] Long workload: scripts/monitoring-bench.ts completed 900,974 ms with 423 producer passes,
  946 successful CLI readers and 14 managed rows. Every simultaneous pair shared generation and
  sequence. Producer CPU: 12,462.039 ms plus 19,337.690 ms observation-child CPU; reader CPU
  including children: 95,578.479 ms. Exec counts: 6,345 producer observation children (15 per pass),
  946 reader processes and zero reader-triggered observation children. Read latency p50/p95:
  56.265/83.008 ms; observation freshness p95/max: 741/1,107 ms. Sampled producer maximum RSS:
  217,808,896 bytes; retained metadata caches remain separately capped at 1 MiB/512 entries each.

### Release verification

- [x] Version 0.39.8 was published from tag commit 3e5b391db986904a4b52a2e9f876a2b01bd80391.
  CI and bundle smoke passed. The 2,179,594-byte artifact SHA-256 was
  b5f103b47c7757e5aec70a06a519a0d91a02130f67c34331fd716833c58b4b81.
  All three owned runtimes matched it and returned advancing live snapshots with 14/14/5 rows,
  no omissions, registry identity parity, and unchanged tmux identities/creation times.
- [x] Rollout exposed a duplicate-install race: manual and automatic installers could replace
  the rollback backup with the already-installed release. src/commands/update.ts now serializes
  swaps with the existing owner-aware lock in src/config/registryLock.ts, skips backup replacement
  for identical bytes, and aborts if backing up fails. test/update-swap.test.ts proves 20 concurrent
  real-process installers preserve the predecessor and that failed backup leaves the live file intact.
  Monitoring producer/reader code is unchanged from the completed 15-minute workload.
  Follow-up full typecheck/test gate passed: 696 tests, zero failures.
