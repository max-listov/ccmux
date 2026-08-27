---
title: External thread turn-state independent of writer ownership
description: Expose explicit bounded turn lifecycle evidence so consumers do not infer execution from shared writer locks.
type: task
status: in-progress
created: 2026-08-27
updated: 2026-08-27
---

## Problem

`ccmux external --json` reports `writerEvidence=observed` and `writerRuntime.kind=shared`
for both an actively executing Codex App thread and an idle thread. The shared App Server
holds their writer locks after a turn completes. This is valid ownership evidence, not
execution evidence, as documented in `docs/architecture/external-session-ownership.md`.

`src/external/codex.ts` exposes writer ownership and last transcript activity but no explicit
turn lifecycle. Consumers cannot distinguish working from idle using this contract.
Recent transcript activity and a final-looking message are not substitutes for turn state.

## Result

- Add an independent external turn-state observation with timestamp, provenance and explicit
  unknown/unavailable/stale outcomes. Keep writer ownership and admission semantics unchanged.
- Use provider-native lifecycle evidence where available. A held lock, PID, loaded thread or
  activity timeout must not alone mean working or idle. Unsupported access reports unknown.
- Document the read contract and ship a release usable by external inventory consumers.

## Acceptance

- [x] Two threads held by one shared runtime remain independently working and idle after one
      completes its turn; ownership evidence stays observed for both.
- [x] Cover start, completion, interruption, approval/input wait, reconnect and missing/stale
      evidence without retaining a false working state.
- [x] Bound observation cost and avoid consumer-side transcript scans on every poll.
- [x] Add regression tests and verify against real active and completed App threads.
- [ ] Update the external contract documentation and publish the release.

## Plan

Keep writer ownership/admission independent. Inspect the installed provider status protocol,
then add a bounded read-only observation over the existing App Server connection. Unsupported,
missing, disconnected or stale evidence must never inherit working state from a writer lock.
Verify independent threads, lifecycle transitions, bounded reads and real App inventory before
publishing and rolling out the owner patch.

## Что сделано

- `src/external/turnSchema.ts`, `turnState.ts`: independent native state, receipt/expiry,
  provenance and fail-closed outcomes. `src/commands/external.ts` exposes JSON and a TURN column.
  Ownership discovery and admission remain unchanged.
- `src/agent/codex/appServer.ts`: cancellation and bounded control-socket messages/handshake;
  initialize version evidence prevents a no-scan option from being ignored on older runtimes.
- `test/external-turn-state.test.ts`: shared-writer independence, start/completion/interruption,
  approval/input flags, reconnect/missing/stale, 100 reads, page limits, unsupported runtime and
  real Unix WebSocket byte/deadline regressions. Existing external/takeover fixtures were updated.
- Real App Server E2E: two new test threads, one shared PID, both writer locks observed;
  completed thread idle while the other worked; interrupt and reconnect yielded idle for both.
  Only test threads were mutated, then archived. Private identities are not included here.
- Real 100-read benchmark: 100 list requests with `useStateDbOnly`, p50 32.9 ms, p95 51.3 ms,
  max 53.6 ms, reader CPU 0.80 s user / 0.51 s system across all reads. Discovery ran once.
- Contract and freshness/unsupported-runtime boundaries documented in
  `docs/architecture/external-session-ownership.md` and README. Publication/rollout remains pending.
- Full pre-release gate: typecheck and 715 tests / 106 files, 2,827 assertions passed. Built CLI
  verification found native working evidence independently from historical/not-loaded threads.
