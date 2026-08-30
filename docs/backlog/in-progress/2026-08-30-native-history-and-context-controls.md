---
title: Native conversation history and explicit context operations
description: Read bounded native history and expose safe fork and compaction semantics without copying transcripts or conflating rollback with file restore.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
priority: P2
pipeline: native-harness-control
order: 5
depends-on:
  - 2026-08-30-managed-image-attachments.md
  - 2026-08-30-native-content-stream-and-replay.md
related: ../done/2026-08-10-discover-and-own-external-codex-threads.md
---

## Why

`native.read` is a bounded current projection, not a history API. The public managed control contract
does not expose fork or manual compaction. Existing external CLI discovery/fork is a different
ownership path and must not be duplicated or advertised as managed service support.

T3's [adapter contract](https://github.com/pingdotgg/t3code/blob/8dcb96314c976899e4df6951fb9af03131c2a46f/apps/server/src/provider/Services/ProviderAdapter.ts)
provides `readThread` and rollback. The native [Codex API](https://learn.chatgpt.com/docs/app-server)
also provides fork and compact, but marks `thread/rollback` deprecated. The
[OpenCode API](https://opencode.ai/docs/server/) exposes messages, fork, summarize and revert.
These operations are not interchangeable: context rollback must not quietly restore workspace files.

## Result and phased state

1. **Read:** a bounded authenticated native-history page carries stable item/turn identity,
   attachment references, native completeness/cursor evidence and explicit omission. Reads do not
   start inference, resume an unrelated thread, replay tools or mutate the session.
2. **Fork:** a deliberate idempotent operation reserves a new managed registration, performs the
   provider-native fork and binds its new native continuation. The source identity and writer remain
   unchanged. Uncertain native fork must be reconciled, not repeated with another new conversation.
3. **Compact:** a serialized native operation transitions from ready to accepted/running and only
   to completed on native evidence. Same identity persists; new inputs cannot race compaction.
4. **Rollback policy:** inspect supported versions and workspace effects. Expose rollback/revert
   only if safe semantics are explicit and testable; otherwise return a specific unsupported
   capability and document a non-destructive native fork alternative. Do not build a new API around
   a deprecated endpoint without a compatibility/removal decision.

Native history remains authoritative. Stream/replay state is an observation cache; context changes
advance its revision/reset boundary so clients cannot combine pre-change and post-change history.
Attachment retention follows references in source and fork; cleanup cannot break either history.

## Plan

- [x] Add bounded native-history reads through driver/contract/client/service descriptor. Inspect native
  pagination support; if a provider only returns a large whole response, enforce bytes/deadline and
  report that limit honestly rather than synthesizing a supposedly cheap unbounded page operation.
- [x] Define independent capabilities for history, fork, compact and rollback/revert, including version,
  idle/request gates, resource costs and mutation effects. No single `contextControl: true` shortcut.
- [x] Implement native fork using the current reservation/registration journal. Preserve workspace,
  host recipe authority, effective selection and safe lineage metadata without copying JSONL files.
  Specify fork-point support and inherited versus pending requests; never inherit live request IDs.
- [x] Implement manual native compaction with exact operation identity and recovery. Never send a
  textual `/compact` command through the prompt or call a model ourselves to produce a summary.
- [x] Audit native rollback/revert source and document workspace-side effects, deprecation and recovery.
  Refuse any operation that cannot preserve the advertised scope; no hidden Git reset/file restore.
- [x] Integrate history revisions with content-stream resets, attachment references and queue admission.
  Update architecture/ADR and runnable published-client examples with actual per-runtime limits.

## Acceptance

- [x] Both real native runtimes expose multi-turn text/image history through the service with bounded
  reads; reconnect/restart preserves identity and ordering. A history read never creates a writer.
- [x] Native fork preserves prior context and attachment usability, returns a distinct managed/native
  identity and leaves the source unchanged. Duplicate/lost-reply create-fork retries create at most
  one destination; uncertainty remains held until exact reconciliation.
- [x] Compaction completes on native evidence, preserves continuity and accepts a subsequent useful
  turn. Busy/approval/input, concurrent message admission, cancellation and restart races are covered.
- [x] A context change resets stale cursors explicitly. Readers cannot join incompatible history
  revisions or silently display incomplete data as a complete conversation.
- [x] Rollback/revert support or explicit refusal is backed by native version/source and a fixture
  proving workspace effects. Unsupported/deprecated behavior is not counted as parity achieved.
- [ ] Existing archive/history retention and interactive external-fork behavior remain unchanged.
  Packed Bun/Node consumers, full local gates and exact-SHA CI pass; record release/artifact hashes
  and verify exact owned-runtime rollout with native-history/fork/compact E2E.

## Boundaries

No second transcript database, filesystem snapshot service, automatic fork-on-resume failure,
cross-runtime history conversion, official Desktop adoption or consumer UI changes. Part of the
[native control roadmap](2026-08-30-native-harness-control-parity.md); all slices share one integrated release.

## Что сделано

- `src/context/` and `src/control/context.ts` provide bounded native pages, journaled fork/compact
  and exact context revisions through the existing owner. Native adapters, current typed clients
  and packed consumer fixtures share this contract. The architecture and context ADR record native
  version evidence, byte/deadline limits and explicit unsupported rollback/revert.
- `scripts/native-context-acceptance.ts` passed with actual Codex and OpenCode: multi-turn image/
  text history, pagination, distinct fork identities, source preservation, retained image preview,
  duplicate fork, native compaction, exactly one reset revision, useful post-compact input and
  provider/daemon restart with late retry. Combined evidence digest: `dcdedecf612f5665`.
- Post-review context-pump reruns passed separately for both actual runtimes (evidence digest
  prefixes `b0549732f07faab5` and `41c9496889deb9c2`). Cleanup archived only fixture registrations;
  all tracked fixture writers/providers were stopped.
- Regression fixtures prove cancellation, held uncertainty after lost ACK, no automatic duplicate
  fork, no completed receipt before durable reset, stale cursor refusal and one unresolved Codex
  RPC across repeated cancellations. An actual OpenCode SDK fixture keeps status and permission
  responses usable during a stalled history fetch; shutdown cancels promptly and late ACK stays
  nonterminal. History image references preserve exact native order and repeated references.
- Native rollback/revert remains explicitly unsupported before mutation; no workspace restoration
  is performed or claimed. Existing archive/external-fork tests remain in the complete regression gate.
- Both independent implementation validators passed the package and final pump/order rechecks.
  Exact-SHA CI and published-runtime evidence remain open in the global release gate.
