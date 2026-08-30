---
title: Retained native message receipts through the current control service
status: accepted
date: 2026-08-30
---

## Context

Durable `message.send` acceptance proves queue admission, not native execution. Native content and
history identify turns, but a reconnecting client cannot infer a turn from text or observation
order. Existing pickup already reconciles Codex `clientId` and the OpenCode mailbox's immutable
native input ID, then discards the pickup after terminal completion.

## Decision

Publish `message.operation`, a bounded metadata read using the original message UUID, exact target
and registration generation. Retain the existing delivery authority's receipts under the managed
runtime root. All writes use the existing native-admission critical section; no additional provider
writer, event consumer, delivery queue or retry loop. The chat ledger remains queue/idempotency
authority; this projection never causes submission.

Acceptance reserves `preparing` before ledger append and marks `queued` only after append succeeds.
A retry can finish this reservation using the same ledger fingerprint. Dispatch persists
`uncertain` before the provider effect. Only a positive native ACK or exact existing reconciliation
record sets `admitted` and `turnId`. Exact terminal evidence sets `completed`, `interrupted` or
`failed` before pickup removal. A lost ACK without positive proof stays uncertain; neither timeout
nor absent bounded history permits resubmission. Terminal evidence is immutable. Subsequent native
bootstrap/external turns cannot replace its binding.

The projection stores sender/request digests, UUIDs, native identity, state and timestamps; no body,
credential, path or provider diagnostics. The same authenticated sender, target and generation gate
reads. Unauthorized, unknown, replaced, malformed or evicted evidence returns `unavailable` without
identifying which check failed. Retained expired rows return `expired`. Reads do not repair storage,
contact providers or scan chat/transcript history.

## Bounds and consequences

One atomic owner-private projection has at most 256 records and 512 KiB. Terminal records have a
seven-day TTL; capacity can evict older terminal records sooner. Pending/uncertain rows are never
evicted for capacity; a full pending window refuses new control admission before ledger append.
Clients must retain IDs and consume evidence within this window, not assume an eternal audit
archive. Receipts outlive native content/history windows and daemon/provider processes.

Earlier accepted messages and CLI/peer messages have no retroactively fabricated records: reads
return unavailable. Rollout does not resend them, migrate identities or delete history.
`observedAt` denotes receipt evidence, not current provider liveness. Use session/native status for
liveness. Rollback removes this operation while leaving private retained metadata and original
queue/pickup semantics intact.
