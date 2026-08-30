---
title: Durable public message-to-native-turn correlation
description: Expose exact admitted message identity alongside native execution evidence for reconnecting control clients.
type: task
status: done
priority: P1
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30T08:18:29Z
---

## Problem

Published `v0.39.29` accepts caller message UUIDs but its public content/history contracts do not
expose their relation to native turn IDs. A client preserving its own durable submission IDs cannot
prove which accepted message produced a terminal record after reconnect, deferred delivery or a
provider bootstrap turn. Matching text, parsing the rendered chat envelope, assigning FIFO by
observation time, or reading private runtime files is not an acceptable replacement.

## Exact evidence

Executed the public schemas from the installed `v0.39.29` tag archive:

- `ControlMessageReceiptSchema` accepts `{ messageId, accepted, duplicate, turnOptions }` only.
- `ContentRecordSchema` carries `turnId` and `itemId`, with no caller submission identity.
- `NativeHistoryEntrySchema` carries `turnId`, `itemId`, content and omission metadata, with no
  `clientId` or caller submission identity.
- The published descriptor has no message-operation read that returns the native binding.
- `src/chat/ownedCodex.ts` and `ownedCodexReceipt.ts` already resolve native receipts internally;
  `src/chat/nativeRuntime.ts` binds the durable pickup message ID to its native ID. Reuse these
  authorities rather than infer another mapping in a consumer or create another journal writer.

These are contract-level observations, not a claimed live provider failure. The readiness fix in
`v0.39.28` and acceptance-loop fix in `v0.39.29` do not change these public schemas.

## Result

One public, typed, bounded and authority-checked way to reconcile a caller message UUID with
managed registration, native session, native turn and outcome. Queued/uncertain delivery must
remain distinguishable from native admission and terminal completion. Preserve one writer and
existing message retry fingerprints; do not require replaying a side effect to obtain evidence.

## Plan

Implementation decision: add `message.operation`, scoped to authenticated sender, exact target and
registration generation. The existing admission/delivery authority retains its native receipts in
one bounded per-registration projection; no new provider writer, replay or background correlator.
States: preparing (public uncertain) → queued → uncertain (dispatch intent) → admitted →
completed/interrupted/failed. Terminal receipts survive pickup deletion and native history eviction.
Only exact native receipt IDs advance admission/completion. Missing, expired, corrupt or replaced
registration evidence returns unavailable/expired, never a guessed binding. Retain at most 256
receipts, evict terminal records only, and expire terminal evidence after seven days. Pending
operations are never evicted to make capacity. Public reads perform no provider/ledger scan or write.

- [x] Inspect the existing durable pickup and native receipt authorities for both runtimes.
- [x] Publish the binding through the current control/content contract or a bounded operation read;
  choose the smallest seam that survives restart and bounded stream/history eviction.
- [x] Scope access to the same authenticated caller/target rules, with no secret or private path
  values in public results. Native bootstrap/external turns may have no caller binding.
- [x] Update public exports, descriptor when applicable, docs and packed consumer coverage.

## Acceptance

- [x] Two identical-text submissions, deferred input, an intervening bootstrap/external turn and
  reconnect resolve to their exact caller UUIDs without text/order/time heuristics.
- [x] Retry and lost native ACK preserve the same binding and do not duplicate execution.
- [x] Both Codex and OpenCode retain correlation through daemon/provider restart; expired or
  unavailable evidence is explicit, not silently reassigned.
- [x] A client using only the published service/stream surface associates terminal completion with
  its exact submission; no SSH, private state-file access or native direct-writer shortcut.
- [x] Publish the verified patch/client artifact and report exact version, source SHA and real
  acceptance evidence. This task does not depend on the optional custom harness.

## Что сделано

- `src/chat/messageOperationSchema.ts` and `messageOperationStore.ts` retain bounded receipts in
  the existing native-admission critical section. Existing Codex exact-client-ID reconciliation and
  OpenCode mailbox acceptance advance those receipts; no provider effect is replayed for reading.
- `src/control/messageOperation.ts`, both control contracts/clients, service descriptor and ingress
  expose `message.operation` with effect `message.read`. Public exports include schemas and types.
  The architecture and matching decision document the state machine, privacy and retention bounds.
- `test/message-operation.test.ts`, native delivery/durability tests and actual Unix service tests
  cover identical text, immutable bindings, sender/registration isolation, corruption/oversize,
  explicit expiry, pending-capacity refusal before ledger append, and lost native ACK recovery.
- Complete local gate passed: 944 tests / 4,646 assertions / 151 files, Biome, TypeScript, packed
  Bun/Node execution and NodeNext/bundler consumers. This is pre-publication evidence.
- `scripts/message-correlation-acceptance.ts` passed with real Codex and OpenCode: identical-text
  submissions, deferred message, intervening other-caller turn, caller reconnect, exact public
  content/history joins, duplicate retry, daemon restart and both provider restarts, then new
  correlated turns. Two fixture sessions archived; five tracked processes exited. Evidence SHA-256:
  `812aedacf402482839e1d5d511af45c9a842b4d6c057309912d75fff5970c236`.
- Earlier probe failures were fixture readiness errors (launch selector constraints and explicit
  unavailable snapshots during startup/restart); their logs are retained, not relabelled as success.
  Published-artifact acceptance and rollout remain pending below until actual publication.

## Post-publication acceptance finding

The published `v0.39.30` artifact reached all three installations with exact bundle parity and
preserved all 33 pre-existing running sessions. Packed consumers passed. Its isolated live probe
stopped before message submission: temporary native catalog cleanup raised `EPERM` from the
zero-signal process-group probe in `ownedChildAlive`, after SIGTERM was already sent. The native
server exited, but that observation error incorrectly turned a successful catalog read into an
unavailable result. The platform's `kill(2)` contract distinguishes permission refusal (`EPERM`)
from absent process/group (`ESRCH`). Keep checking a permission-denied group until it disappears or
the existing bounded cleanup deadline expires; do not suppress real SIGTERM/SIGKILL failures.
This owner correction stays in the same release conveyor, with a deterministic regression.

## Published evidence and correction

- Published `v0.39.30`: implementation `5e8b6869fcbb47e5fad973f1bc38d7d0cceffa98`, release/tag
  `7e314d7c1c20a4c351551b2f11116eb87a398022`. Exact-SHA CI and smoke passed:
  [33300868453](https://github.com/max-listov/ccmux/actions/runs/33300868453).
- Runtime SHA-256 `bb6773becb944ceeff5b0af113812eddff762a32449ec479d51c9a8e6844262a`;
  published client SHA-256 `dc7563629e37d4d60296d7f6f74d20310ba9a02f2f40986449136557d22a1786`.
  Actual downloaded client passed Bun/Node and both TypeScript resolution gates. The same client
  read the new operation from all three updated owners; all 33 running identities/start times stayed.
- Rechecking the same published bundle/client completed all real correlation cases on both native
  runtimes, including both provider restarts and new resumed turns. No private state files or direct
  native writer were used to correlate outcomes. Probe evidence SHA-256:
  `e09288d001cc9644711f5e67828e9807fa848cddcd2149a24edfaf0f67d6288a`.
  Two isolated registrations archived, five tracked processes exited. The earlier cleanup failure
  remains recorded separately; a successful rerun does not remove the owner correction.
- [Public verification artifact](https://github.com/max-listov/ccmux/releases/download/v0.39.30/post-rollout-verification.json),
  SHA-256 `12940ae0c0b5d256bb4bba9eb211ddbcdc8d2054baed596a7d3825e10cc1fa94`.
- `src/agent/codex/ownedChild.ts` now preserves the bounded cleanup loop on a denied zero-signal
  probe. Actual signal failures still propagate. The real-child regression fails on the previous
  implementation (`8c399fa3c8cb4494b69ec5eedb29ef47d7421cf65e985912abbbcaf286caded5`) and passes
  after correction (`6dec50debff50abb3e7c8d68936494dfae18cd6932c9641e5556268db3e7fff0`). The full
  corrective gate passed 945 tests plus packed clients. This meaningful cleanup correction and task
  closure travel together in the corrective patch; final installed evidence belongs to its release
  verification artifact, without a separate bookkeeping commit.
