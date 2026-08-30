---
title: Durable public message-to-native-turn correlation
description: Expose exact admitted message identity alongside native execution evidence for reconnecting control clients.
type: task
status: in-progress
priority: P1
created: 2026-08-30
updated: 2026-08-30
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
- [ ] A client using only the published service/stream surface associates terminal completion with
  its exact submission; no SSH, private state-file access or native direct-writer shortcut.
- [ ] Publish the verified patch/client artifact and report exact version, source SHA and real
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
