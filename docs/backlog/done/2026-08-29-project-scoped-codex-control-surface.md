---
title: Workspace-scoped Codex control surface
description: Expose idempotent managed-session lifecycle, bounded native thread events and exact approval control through the resident contract.
type: task
status: done
created: 2026-08-29
updated: 2026-08-29
completed: 2026-08-29
priority: high
---

## Problem

The resident control plane can list, message, start, interrupt and wait for existing managed
sessions, while new session creation remains an interactive/CLI-only operation. A local control
consumer cannot create one workspace-scoped owned Codex App Server session idempotently, archive
it, follow its native conversation items or answer an exact approval/input request.

Status snapshots and turn boundaries are not a conversation feed. Polling provider history or
starting a second writer would lose native order and violate ownership.

## Desired result

- The same-user resident contract creates one managed Codex App Server session for an exact
  normalized workspace and immutable request ID, returning the canonical session/thread identity.
- Retry after an ambiguous caller outcome reconciles the request and cannot create another writer.
- Archive/stop has an explicit receipt and preserves provider history for later deliberate recovery.
- A bounded snapshot + cursored stream exposes native user/assistant/reasoning/tool/approval/usage/
  terminal items in causal order, retaining opaque native IDs without leaking credentials or
  unrestricted provider payloads.
- Exact approve/decline and user-input operations address the current native request and fail closed
  when stale, mismatched, terminal or already answered.
- Existing CLI/TUI, durable chat delivery, supervisor recovery and ordinary managed sessions keep
  their established semantics.

## Plan

- [x] Reuse the existing transactional create service behind `ccmux new`; do not add a second
  registry mutation path. Define request identity, workspace validation, runtime flags and receipt.
- [x] Add bounded control operations for create and archive/stop with per-target admission,
  cancellation and delivery-uncertainty semantics.
- [x] Extend the owned App Server observer with a bounded durable/native-item projection. Preserve
  provider order and stable item IDs; snapshot is the resync source after cursor/generation gaps.
- [x] Add a resident framed stream whose first item establishes a baseline and whose overflow/gap
  requires snapshot resync. Do not advertise broker or cross-machine durability.
- [x] Add exact approval/input schemas and native handlers. Never infer approval from permission mode,
  interrupt, message delivery or a blank composer.
- [x] Publish the typed client/bundle and update control/runtime architecture and public examples.
- [x] Run focused contract/recovery/native probes and public install checks, then prepare the normal
  owner release conveyor. Avoid a broad provider matrix; only owned Codex App Server is in scope.

## Acceptance

- [x] Duplicate create request yields one canonical managed session and one provider writer.
- [x] A lost create reply is reconciled by immutable request evidence, never cwd/title guessing.
- [x] One real native turn streams ordered reasoning/tool/text and terminal items; reconnect resumes
  from snapshot/cursor without duplicate items.
- [x] One real approval or input request is answered by exact request ID; stale/mismatched answers refuse.
- [x] Daemon/provider restart resumes the same thread and preserves projection continuity or emits an
  explicit resync boundary.
- [x] Archive stops new routing and owned runtime without deleting unrelated provider history.
- [x] Existing control clients and ordinary TUI sessions remain compatible; no credentials, private
  workspace names or consumer details appear in artifacts, docs or release notes.

## Return result

Report release version, full SHA, packed client artifact/integrity, focused real-native evidence and
remaining provider limitations to the maintainer. Consumer coordination addresses remain outside
this public repository.

## Что сделано

- `src/control/lifecycle.ts` reuses the canonical pending/promotion transaction behind `ccmux new`.
  A private durable receipt and per-request lock reconcile concurrent retries and a lost reply to
  one registration generation, normalized workspace, thread identity and provider writer.
- `src/agent/codex/ownedNative.ts`, `ownedProjection.ts` and `ownedControl.ts` publish a bounded,
  sanitized native ring and route exact approval/input responses back through the subscribed App
  Server connection. Submission and provider resolution remain separate ordered stages.
- `src/control/contract.ts`, `service.ts`, `nativeFeed.ts` and `ccmux/control-client` expose typed
  create, archive, native read/stream and response operations with bounded admission, cursors,
  cancellation, explicit uncertainty and fail-closed identity/generation/request checks.
- Focused lifecycle/connection/control gates pass 29 tests. The full owner gate passes 768 tests.
  The self-contained client test imports and exercises the built asset with provider process spawn
  forbidden and the package registry deliberately unreachable.
- Isolated real-provider probes proved one writer across duplicate create, archive with retained
  history, strictly ordered user/reasoning/tool/assistant/usage/terminal projection, exact approval
  and input responses, stale and changed-payload refusal, partial-input holding, provider restart
  with the same thread plus explicit generation resync, daemon restart without writer replacement,
  busy/defer/wait/interruption recovery and bidirectional managed-session messaging before and after
  restart.
