---
title: Add opt-in native ownership of Codex App Server sessions
description: Own native Codex App Server sessions directly in CCMux, with stable identity, resident native state and reliable control through the existing chat contracts.
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
priority: high
related:
  - docs/research/2026-08-28-happy-and-codexmonitor.md
  - docs/research/2026-08-28-codex-control-and-desktop-coexistence.md
  - docs/backlog/icebox/2026-08-28-happy-controlled-adoption-pilot.md
  - docs/backlog/in-progress/2026-08-27-desktop-turn-observation-and-resident-delivery.md
---

## Why

A supervised interactive TUI and a provider-native App Server expose different control surfaces.
An owned native runtime can give multiple clients reliable turn state and structured input
without reading spinner frames. Happy and CodexMonitor demonstrate the client/runtime split,
but adopting either does not attach CCMux to an already-running official Desktop process.

The accepted scope is an opt-in native App Server mode alongside ordinary managed TUI sessions.
CCMux owns the real provider process. Happy and CodexMonitor are architecture references only:
no Happy installation, relay, replacement harness or additional account system is required.

## Result

One declared owner for each new managed Codex runtime, one stable provider identity per
conversation, and native status/control available through existing CCMux contracts. The existing
supervisor owns the provider process; interactive clients attach to it rather than creating a
second writer. Provider environments remain isolated per managed session. The supervisor publishes
bounded native state, and the existing resident daemon projects it for fleet consumers without
another observer or work proportional to reader count.

The provider is the authority for working, idle, waiting-approval and waiting-input. Connectivity,
expiry and runtime generation are separate from turn state. Starting, restarting, unavailable and
identity mismatch never imply idle. Acceptance, turn start and completion are distinct stages;
an uncertain send is reconciled by immutable message identity, never blindly retried.

## Plan

- [x] Use the existing source research and shared-runtime evidence to record an architecture
      decision. Specify which application owns the process, persistence, authentication,
      permissions and recovery. Update VISION only with the accepted ownership decision.
- [x] Define runtime identity, endpoint discovery, supported provider versions and capabilities.
      Separate connectivity, loaded state, active turn, approval/input waits, error and expired
      observations. Persist the provider UUID before accepting addressable messages.
- [x] Implement the opt-in native driver behind the existing provider boundary, using the
      supported local Unix control transport and exact provider identity. No internal Desktop
      peer impersonation, private-process bridge or concurrent second writer.
- [x] Register event handling before the initial snapshot, use connection generations and
      bounded reconciliation, and expose fresh state through the existing resident daemon.
      Coordinate this shared projection with the active external-observer task; do not create
      another observer daemon or per-consumer transcript scan.
- [x] Route existing `msg`, `wait`, defer and reply identity through native turn/input operations.
      Specify acknowledgement stages and idempotency. Busy and pending approval/input fail
      closed unless the caller explicitly selects a supported queue/steer operation.
- [x] Add restart/resume, adoption exclusion and disposal behavior. Missing or mismatched
      persisted identity fails closed; never replace a failed resume with a fresh thread.
      Preserve ordinary TUI sessions and provider subscription authentication.
- [x] Demonstrate an interactive client and a CCMux reader controlling/observing the same owned
      runtime. Separately state whether the official Desktop client can attach with its native
      capabilities intact; history visibility alone is not live coexistence.
- [ ] Add regression coverage, update architecture, run agreed gates and release from the
      canonical checkout. For an authorized implementation release, include all owned runtime
      rollout, version/hash parity and post-rollout verification.

## Acceptance

- [x] Two new managed Codex sessions complete A→B and B→A through `ccmux msg`, retaining exact
      provider + machine + session reply identity before and after restart/resume.
- [x] Live working/idle/approval/input/interruption transitions agree with independent provider
      events; host loss expires positive state within the declared freshness budget.
- [x] Busy, partial input, approval, duplicate/retried send, stale snapshots and resume failure
      cannot create duplicate turns, silently change identity or acknowledge false completion.
- [x] Reader concurrency does not multiply provider sessions, connections or transcript scans;
      measure bounded CPU/RSS and event delivery under load.
- [x] The selected interactive client and CCMux share one actual writer. Existing official
      Desktop sessions are untouched and are not claimed as covered by this new-runtime test.
- [ ] A released implementation includes complete task evidence, public-safe documentation,
      release/tag and fleet runtime verification; a design or pilot alone is not a release.

## Что сделано

- [x] Runtime: `src/agent/codex/ownedProcess.ts`, `ownedChild.ts`, `ownedConnection.ts` and
      `ownedLaunch.ts` own native processes, private endpoints, subscription generations and
      pinned resume. Real wrapper SIGKILL exposed a surviving native child; process-group disposal
      and explicit launcher liveness now prevent that orphan. `test/codex-owned-child.test.ts`
      reproduces the inherited-pipe case.
- [x] State: `ownedProjection.ts`, `ownedStatus.ts`, `ownedRead.ts`, `ownedCursor.ts` and
      `ownedEvents.ts` provide the bounded native projection, existing lifecycle feed and resident
      ESM reader. `test/codex-owned-connection.test.ts` exercises real Unix WebSocket races,
      disconnect/reconnect, wrong UUID, malformed status and retired-generation exclusion.
- [x] Chat: `src/chat/ownedCodex.ts`, `ownedCodexReceipt.ts` and `pendingDelivery.ts` preserve
      immutable intent/acceptance/receipt stages. Real two-session messages retained full reply
      identities. Busy/defer, typed partial input, denied approval, interrupted pickup and native
      input wait passed through `scripts/codex-owned-e2e.ts` and `codex-owned-safety-probe.ts`.
- [x] Read integration: `src/commands/runtime.ts`, `wait.ts`, `list.ts`, `src/events/observe.ts`
      and `src/monitoring/project.ts` use native state for this opt-in mode, leaving ordinary
      provider paths intact. `test/codex-owned-reader.test.ts` checks the self-contained release
      asset offline, 100 coalesced readers, zero CLI/RPC starts, cancellation/deadlines, bounded
      callers, exact identity and configuration-root migration without stale fallback.
- [x] Interactive evidence: native terminal input started and completed a turn observed via RPC
      and the existing event feed, without changing provider PID/UUID. A daemon restart preserved
      a running turn. A provider-wrapper SIGKILL invalidated positive status in 52.2 ms and
      automatically resumed the same UUID under a new provider PID/generation.
- [x] Documentation: `docs/decisions/2026-08-28-owned-native-codex-runtime.md`,
      `docs/architecture/owned-codex-runtime.md`, `docs/architecture/monitoring-status.md`,
      `examples/codex-runtime-reader.ts`, `README.md` and `docs/VISION.md` describe the accepted
      ownership boundary. No Happy deployment or official Desktop takeover is included.
- [x] Gates: final local `bun run check` passed typecheck and 739 tests across 111 files,
      with 3,028 assertions and zero failures. The two-session round trip and busy/defer/receipt
      proof passed again after restart/crash recovery with the original UUIDs.
- [x] Load: 57,700 resident reads in 60.02 seconds, 2.53 seconds reader-process CPU, RSS
      89.7→100.1 MB, prepared file at most 1,328 bytes. A native turn started/completed during
      this load; its completion reached the resident reader 71 ms after the independent native
      event. Reader count did not replace the provider or add per-reader RPC/process starts.
- [ ] Publication and owned rollout: record the exact release/tag, published asset verification,
      post-rollout native test and fleet version/hash agreement before closing this task.
