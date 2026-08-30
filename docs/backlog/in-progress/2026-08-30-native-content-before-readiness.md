---
title: Publish native content before runtime readiness
description: Make the first exact content baseline durable before advertising an admitted native runtime.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
related: ../done/2026-08-30-native-content-stream-and-replay.md
---

## Why

Installed-artifact acceptance found a successful Codex create followed by `native.read` returning
`UNAVAILABLE`. The status writer can publish synchronously while the initial content writer uses
a coalescing timer. A reader can observe the admitted identity before its content baseline exists.

## Plan

- [x] Reproduce status publication preceding a readable content baseline on fresh and resumed admission.
- [x] Persist the initial exact baseline before activating live status callbacks; retain buffered events.
- [ ] Run focused and complete gates, then real isolated two-runtime acceptance with notifications absent.
- [ ] Publish the corrective patch and verify installed artifacts, session continuity and live clients.

## Acceptance

- [x] Every admission status publication has a readable content baseline with the exact identity.
- [x] Initial content-write failure refuses admission instead of advertising readiness.
- [ ] Native requests, chat, busy/defer, interruption and restart/resume pass through the public service.
- [ ] Release evidence records exact artifact hashes, CI and owned-runtime parity without private data.

## Что сделано

- [x] `src/agent/codex/ownedConnection.ts` flushes the initial content baseline before enabling
  projection callbacks. Native callbacks remain buffered during the atomic write.
- [x] `src/agent/opencode/connection.ts` commits the baseline before subscribing to native events.
- [x] `test/codex-owned-connection.test.ts` reproduces the pre-fix failure and verifies fresh/resumed
  ordering plus fail-closed write errors. `test/opencode-content-readiness.test.ts` verifies the
  corresponding callback boundary and write failure. Focused gate: 12 tests, zero failures.
- [x] `docs/architecture/native-content-and-turn-controls.md` declares the readiness ordering.
