---
title: Native conversation history and explicit context operations
description: Read bounded native history and expose safe fork and compaction semantics without copying transcripts or conflating rollback with file restore.
type: task
status: done
completed: 2026-08-30 13:15 +07:00
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
- [x] Existing archive/history retention and interactive external-fork behavior remain unchanged.
  Packed Bun/Node consumers, full local gates and exact-SHA CI pass; record release/artifact hashes
  and verify exact owned-runtime rollout with native-history/fork/compact E2E.

## Boundaries

No second transcript database, filesystem snapshot service, automatic fork-on-resume failure,
cross-runtime history conversion, official Desktop adoption or consumer UI changes. Part of the
[native control roadmap](2026-08-30-native-harness-control-parity.md); all slices share one integrated release.

## Что сделано

- [x] `src/context/` and `src/control/context.ts` provide bounded native pages, journaled fork/compact
  and exact context revisions through the existing owner. Native adapters, current typed clients
  and packed consumer fixtures share this contract. The architecture and context ADR record native
  version evidence, byte/deadline limits and explicit unsupported rollback/revert.
- [x] `scripts/native-context-acceptance.ts` passed with actual Codex and OpenCode: multi-turn image/
  text history, pagination, distinct fork identities, source preservation, retained image preview,
  duplicate fork, native compaction, exactly one reset revision, useful post-compact input and
  provider/daemon restart with late retry. Combined evidence digest: `dcdedecf612f5665`.
- [x] Post-review context-pump reruns passed separately for both actual runtimes (evidence digest
  prefixes `b0549732f07faab5` and `41c9496889deb9c2`). Cleanup archived only fixture registrations;
  all tracked fixture writers/providers were stopped.
- [x] Regression fixtures prove cancellation, held uncertainty after lost ACK, no automatic duplicate
  fork, no completed receipt before durable reset, stale cursor refusal and one unresolved Codex
  RPC across repeated cancellations. An actual OpenCode SDK fixture keeps status and permission
  responses usable during a stalled history fetch; shutdown cancels promptly and late ACK stays
  nonterminal. History image references preserve exact native order and repeated references.
- [x] Native rollback/revert remains explicitly unsupported before mutation; no workspace restoration
  is performed or claimed. Existing archive/external-fork tests remain in the complete regression gate.
- [x] Both independent implementation validators passed the package and final pump/order rechecks,
  including explicit omitted-byte metadata for private synthetic/compaction-summary text.

## Published acceptance

- [x] Corrective release `v0.39.26`, release/tag `24cdb31e2997e4deea9e0e36ee992bc1da71d782`;
  native-package implementation `3c7235454e657cefa5ec570d6fb4c927293b07e4` and metadata privacy fix
  `5b1692f9e3e5ceb7879a0bf99f801316072cab56`. Complete gate: 929 tests, 4,556 assertions;
  both independent implementation re-reviews passed. Exact-SHA CI
  [33296143751](https://github.com/max-listov/ccmux/actions/runs/33296143751) passed.
- [x] Downloaded runtime SHA-256: `6d2685bc49c517ba4abd812f5ed16714d763189328aa8c84fa8356a96c49ed42`;
  downloaded client archive SHA-256: `15475d4f55670be57f803802c78a7d009f0280f0dcdbb88f686ef71100f6b3d8`.
  Actual published bytes passed packed installation, Bun/Node and both TypeScript resolution checks.
  All three owned installations match the runtime version/hash and report live owner projections.
  The 33 pre-existing running sessions retained identity and remained running.
- [x] Repeated installed-bundle/public-client acceptance passed on real Codex and OpenCode: actual
  image recognition, exact preview, native content/history, idempotent create/message/fork, distinct
  fork identity, source preservation, retained image access, native compaction with one revision/reset,
  and retained unfinished checkpoint plus prior image facts. Internal attachment paths are absent
  from public history/content. Evidence SHA-256:
  `17edd555128d5e156b5e1397246ef193fee29258e7c84a716e7b7cdce3f68d9a`.
  Cleanup archived/stopped all four fixture sessions and preserved unrelated registrations/daemon.
- [x] `scripts/opencode-runtime-e2e.ts` passed again against the installed bundle: real tool effect,
  exact input/approval, busy/defer, interruption, two-runtime chat/reply identity, daemon/provider
  restart and continuation, then archive. Evidence SHA-256:
  `429f099cd94a0f8035755acdf50f05dcba8bfabb6c073192341c07299bbfa30d`.
