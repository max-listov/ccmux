---
title: Native bounded monitoring-status read without a reader process
description: Expose the existing status authority to resident consumers without starting a CLI for each read.
type: task
status: done
created: 2026-08-27
updated: 2026-08-27
completed: 2026-08-27 21:46 +07:00
priority: P2
---

## Evidence and boundary

Version 0.39.9 successfully removes per-reader transcript/tmux scans through
`ccmux status --json`. Its documented public consumer door is still a CLI invocation.
`docs/architecture/monitoring-status.md` names a file under the configured state root,
but does not declare a native discovery/read contract. Consumers must not reproduce private
configuration resolution or bypass producer-liveness, identity and freshness validation.
This is a follow-up optimization, not a failure of the completed scan-elimination task.

## Requested result

Declare one supported native read door for the existing protocol-1 projection. Choose a
fixed owner IPC operation or an explicitly supported native file-reader interface; reuse
the existing daemon and projection. No second observer/supervisor, caller path, shell,
refresh selector, session mutation or implicit expensive fallback.

- [x] Document discovery, authorization, configuration/root changes, bytes, deadline and
      cancellation. Preserve PID/generation/sequence, identity, observedAt, omitted and
      live/stale/unavailable outcomes; no falsely live result after daemon death.
- [x] Implement the chosen owner interface and a minimal resident consumer example.
- [x] Prove 100 sequential/concurrent reads cause zero CLI/tmux/transcript execs and no
      additional observation pass; measure latency/CPU and a 15-minute bounded-cache window.
- [x] Cover absent producer, stale data, corrupt/oversized input, restart/root migration,
      cancellation and removed sessions without terminating any supervised session.
- [x] Release and document exact contract/artifact and rollback evidence.

The CLI remains valid. Do not expose transcript bodies, environment values or arbitrary paths.

## Implementation plan

Use a supported `ccmux/monitoring-reader` package export over the existing atomic snapshot.
Share configuration location resolution and snapshot validation with the owner; bound native
file reads, concurrent callers, cancellation and deadlines. No consumer path argument, new
daemon, background observation, transcript access or CLI fallback. Verify the public entrypoint
against real publication and a 15-minute live workload, then release and verify owned runtimes.

## Что сделано

- [x] Public API: `src/monitoring-reader.ts`, `src/monitoring/native-read.ts` and
  `src/monitoring/native-file.ts` expose bounded asynchronous native reads. One in-flight I/O
  batch, at most 128 callers, independent cancellation/deadlines and no completed-result cache.
- [x] Shared authority: `src/config/monitoring-location.ts` owns config selection/location;
  `src/monitoring/validate.ts` shares protocol/identity/liveness/freshness validation with CLI.
- [x] Distribution: `scripts/build-monitoring-reader.ts` and `.github/workflows/ci.yml` build
  and publish a self-contained versioned ESM library with SHA-256 alongside the daemon assets.
- [x] Contract/example: `docs/architecture/monitoring-status.md` and `examples/monitoring-reader.ts`.
- [x] Regression: `test/monitoring-native.test.ts`, `test/fixtures/monitoring-native-io.ts` and
  `test/monitoring-native-bundle.test.ts` cover 100 sequential/concurrent reads, stalled I/O,
  abort/deadline/backpressure, config races/migration, malformed/oversized/unsafe files and
  offline artifact import. `test/monitoring-daemon.test.ts` proves native restart/SIGKILL,
  cancellation, identity/removal updates and pane preservation using an isolated real daemon.
- [x] Full gate: `bun run check`, 704 tests across 105 files, 2582 assertions, zero failures.
  The real daemon E2E includes live state-root migration without terminating its pane.
- [x] `scripts/monitoring-native-bench.ts 900`: 900704.64 ms, 1997 successful reads, 437
  observed publications, 14 rows, zero subprocess attempts. Native latency p50 1.188 ms /
  p95 2.147 ms; freshness p95 2016 ms / max 2197 ms. Reader CPU 4055.659 ms, including
  benchmark GC. Heap first/end/max 6173526 / 4749283 / 6197935 bytes; max RSS 113557504
  bytes. No completed snapshot cache; measurement used the live protocol-1 producer 0.39.9.
- [x] Linux kernel trace of the self-contained reader: 201 successful calls, only the initial
  Bun execve and zero child execve; 102 snapshot opens and 204 configuration opens, with no
  transcript/tmux access. A second Linux runtime passed 201 reads with five rows/zero omissions.
- [x] Published [v0.39.10](https://github.com/max-listov/ccmux/releases/tag/v0.39.10),
  tag/source `b8a46e682e0a5e520cd903bad83909356ab0fcff`; implementation
  `5206605f52ae7b9dd44fa302699faa16f778180b`. Main CI 33083720387 and release CI
  33083720923 passed, including typecheck/tests, built-bundle smoke and library publication.
- [x] Published and installed daemon bundle SHA-256:
  `beddede924936e14106ecf8fd604ec27b06ce24b69a4ecc7c75e8dd6be6c236f` (2180998 bytes).
  Native ESM SHA-256:
  `f202aed71b3ed272a0a2f905ee43ca90de614d755e67de734a46b7e7e863359d` (564515 bytes).
  The downloaded bytes match the release manifest/checksum and GitHub asset digests.
- [x] All three owned runtimes report 0.39.10 with the exact daemon hash. Native artifact
  verification passed 201 calls per runtime, reader/producer versions both 0.39.10, rows
  14/14/5 and zero omissions. Snapshot PID matches the service PID; generation changed on
  rollout, sequence advances, registry identities match and all pre-rollout tmux panes survive.
  Current daemon boot logs have no warnings/errors. Published-artifact Linux trace again shows
  only the initial Bun execve, zero child execve, 102 snapshot and 204 configuration opens.
- [x] Rollback predecessor is preserved on every runtime: 0.39.9 bundle SHA-256
  `6f5b0ceb4310773fd304475ddbe81521a4204e0b9765107cc26d70256f2391b5`.
  Native protocol-1 compatibility with that producer was exercised by the full live benchmark;
  no production rollback or supervised-session restart was needed. Consumer deployments are
  separate from this owner release; importing the native library does not start another daemon.
