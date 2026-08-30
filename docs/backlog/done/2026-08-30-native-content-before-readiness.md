---
title: Publish native content before runtime readiness
description: Make the first exact content baseline durable before advertising an admitted native runtime.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 14:26 +07:00
related: ../done/2026-08-30-native-content-stream-and-replay.md
---

## Why

Installed-artifact acceptance found a successful Codex create followed by `native.read` returning
`UNAVAILABLE`. The status writer can publish synchronously while the initial content writer uses
a coalescing timer. A reader can observe the admitted identity before its content baseline exists.

## Plan

- [x] Reproduce status publication preceding a readable content baseline on fresh and resumed admission.
- [x] Persist the initial exact baseline before activating live status callbacks; retain buffered events.
- [x] Run focused and complete gates, then real isolated two-runtime acceptance with notifications absent.
- [x] Publish the corrective patch and verify installed artifacts, session continuity and live clients.

## Acceptance

- [x] Every admission status publication has a readable content baseline with the exact identity.
- [x] Initial content-write failure refuses admission instead of advertising readiness.
- [x] Native requests, chat, busy/defer, interruption and restart/resume pass through the public service.
- [x] Release evidence records exact artifact hashes, CI and owned-runtime parity without private data.

## Что сделано

- [x] `src/agent/codex/ownedConnection.ts` flushes the initial content baseline before enabling
  projection callbacks. Native callbacks remain buffered during the atomic write.
- [x] `src/agent/opencode/connection.ts` commits the baseline before subscribing to native events.
- [x] `test/codex-owned-connection.test.ts` reproduces the pre-fix failure and verifies fresh/resumed
  ordering plus fail-closed write errors. `test/opencode-content-readiness.test.ts` verifies the
  corresponding callback boundary and write failure. Focused gate: 12 tests, zero failures.
- [x] `docs/architecture/native-content-and-turn-controls.md` declares the readiness ordering.

## Installed acceptance follow-up

The downloaded corrective artifact passes initial reads, real tools, exact input, busy/defer and
interruption. The cross-runtime probe observes both pinned messages, then stops servicing approvals
while waiting for pickup. A later native approval remains correctly pending and the test times out.
`scripts/runtime-coexistence-e2e.ts` keeps the approval pump active until both real turns settle.
`test/runtime-coexistence-probe.test.ts` verifies a late approval and fail-closed terminal failure.
The failed evidence is retained separately; no runtime approval requirement was weakened.

## Published result

- [x] Corrective release `v0.39.28`, release SHA `1b25c2f6a2596173d74a79c6e7cf28aef5433951`,
  implementation SHA `91285421b432c7eb899815540155d776c729147c`. Exact-SHA CI
  [33298646419](https://github.com/max-listov/ccmux/actions/runs/33298646419) passed.
- [x] Downloaded runtime SHA-256 `cc306cb36d5229110f8bf1907f48b4d824620abf8a950ee121e2aa9650aea60c`;
  client archive SHA-256 `746801c5d9ceddfa662387f3c3676997255f6587c5c11202a5d0ff4719c5a2c4`.
  All three owned runtimes match; all 33 pre-existing running sessions retain identity and start time.
- [x] Real downloaded-bundle acceptance passed native tools, exact approval/input responses,
  busy/defer, interruption/recovery, pinned two-runtime chat, daemon restart preserving both writers,
  provider restart/resume and archive. Evidence SHA-256
  `94524017a24437cb3003daef68ebfa4f5461884c49d7a974575f0dbd3eee7ea3`.
- [x] Fixture configuration excludes notifications; none of its ten messages entered the production
  ledger, and fixture processes stopped. Production acceptance uses read-only service operations.
- [x] Final validation-runner changes pass 936 tests / 4,597 assertions / 150 files, Biome,
  TypeScript and packed Bun/Node consumers. Focused gate passes 14 tests / 81 assertions.
- [x] The [public verification artifact](https://github.com/max-listov/ccmux/releases/download/v0.39.28/post-rollout-verification.json)
  preserves successful and failed evidence. SHA-256
  `c9e73785fa84690820349f928c0234314a4dbb62dfbe5250a2f7e35eaf1921d1`.
