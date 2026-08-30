---
title: Managed Codex, OpenCode and custom harness runtime adapters
description: Define one session supervision contract across structured native runtimes and an optional Stitchkit harness without owning their agent loops.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
priority: P1
---

## Problem

The current managed control lifecycle creates a Codex session explicitly in `src/control/lifecycle.ts`.
`src/agent/index.ts` registers Claude and Codex providers. A client needs to select an execution
runtime independently from the inference provider/model while preserving the same managed identity,
control, restart and stream boundary. Treating every model as a Codex session does not meet that need.

## Scope and identity

CCMux is the session supervisor and control service: installation/launch selection, workspace,
one writer, native identity, readiness, stop/resume, requests and structured runtime events.
It is not a model inference proxy, universal agent loop, application prompt manager or UI.
Update VISION and architecture to describe native headless servers as well as interactive clients.
Document naming options separately; do not rename package, binary, repository, paths or services
as part of this task. Existing interactive sessions remain supported and untouched.

The supported family includes Claude Code, native Codex, native OpenCode and the custom harness.
Claude's existing interactive lifecycle remains supported; capabilities must distinguish it from
structured native control rather than synthesize approval/input support. Reference implementation
research uses T3 Code's driver registry, continuation identity and structured OpenCode event adapter.
No UI framework, inference loop or product-owned tools/prompts are copied into CCMux.

## Execution sequence and state authority

1. Inspect the existing registry/control contracts, current T3 Code source and the official OpenCode
   server/SDK. Record native identifiers, request correlation and event-completion behavior.
2. Define one driver boundary and explicit capabilities. Managed registration remains the identity
   authority; native session IDs and process ownership are runtime-specific continuation evidence.
3. Adapt control create/read/message/respond/interrupt/wait/archive and supervision to driver lookup.
   Preserve Codex receipts and interactive Claude behavior without terminal parsing for native lanes.
4. Add authenticated owned OpenCode startup, bounded event projection and native recovery. Never
   kill an adopted external server or replay an indeterminate side-effecting prompt on reconnect.
5. Integrate the published custom-harness seam when available. Unpublished owner source is evidence
   for coordination, not a runtime dependency or an excuse to reproduce its loop in this repository.
6. Validate real sessions and packed consumers, then publish and verify the owned installations.

State transitions: absent → reserved → starting → ready; ready → working → waiting-input/approval
or terminal; disconnected → unavailable → reconciling → ready; archived is excluded from healing.
Only a native terminal event or reconciled native terminal record completes a turn. Transport closure
never implies success. Exact registration, process epoch, native session and request identity gate
mutations; retries reconcile the same reservation and never create a second writer.

## Result

- One typed runtime-driver contract for create/get/input/respond/interrupt/snapshot/stream/archive
  with source runtime identity, durable admission receipts, capability discovery and version evidence.
- Runtime identity and inference selection are separate. Launch profiles describe host authority
  and credentials, not one copy per catalog model. Unsupported combinations refuse explicitly.
- Codex adapter uses App Server structured protocol, retaining the existing native catalog/model
  correctness tasks. OpenCode uses its server API/SDK and structured event stream, not its TUI.
- Custom harness adapter supervises a process using the published Stitchkit harness surface.
  CCMux contains thin host composition/control mapping, never a copied provider/tool loop.
- Model, instructions, tools and permission capability evidence remains runtime-specific. A shared
  view must not invent parity. Native raw evidence remains available for diagnosis and reconstruction.

## Plan

- [x] Specify the common contract/state machine and supervisor vs runtime ownership before adapters.
- [x] Preserve current Codex catalog/selection work; consume its release without resetting identity.
- [x] Implement managed OpenCode server startup or explicit adoption, authenticated SDK control,
  native session resume, tool/request mapping and bounded streaming. An externally owned server
  must never be stopped as a child owned by CCMux.
- [ ] Integrate the published optional Stitchkit harness with host-supplied configuration/tool policy
  and SQLite placement; ship a reproducible thin runner/entrypoint with an exact dependency version.
- [x] Bind plugin/driver capabilities to the published local/service clients and descriptor; no
  runtime-specific branches in the cross-machine transport.
- [x] Update lifecycle documentation, release artifacts and compatibility/rollback instructions.

## Acceptance

- [ ] Codex, OpenCode and custom harness sessions coexist without writer or transcript identity collisions.
- [ ] OpenCode and custom harness each perform a real external-model tool turn in an isolated workspace.
- [x] Retry preserves identity; interruption and restart/resume do not duplicate tool side effects.
- [x] Tool calls, reasoning, text, usage and terminal outcomes preserve causal order; transport closure
  alone cannot report success. Unsupported approval/input features are reported honestly.
- [x] Existing Codex/interactive session behavior is retained; no terminal scraping for new native lanes.
- [x] Real receipts identify runtime/provider/model/version. Compatibility probes of external models
  inside Codex are optional evidence, not a requirement that all providers pass through Codex.
- [x] Publish the driver/client release and report runnable examples plus remaining capability gaps.

## Dependencies

Codex fixes are published in `v0.39.23`: `../done/2026-08-30-model-catalog-before-first-managed-session.md`
and `../done/2026-08-30-managed-model-selection-and-collaboration-policy.md`. OpenCode implementation and
driver-contract work can proceed independently. Custom driver waits only for the published
Stitchkit harness seam; agree that boundary through the existing owner-task handoff process.

## Что сделано

- Added `src/runtime/` driver/capability, lease, status, mailbox and private diagnostic boundaries.
  `runtime.list` and typed create runtime selection reuse the existing local/service descriptor;
  omitted runtime and old Codex create fingerprints remain compatible.
- Added `src/agent/opencode/` using pinned `@opencode-ai/sdk@1.18.20`: authenticated owned loopback
  startup, exact native continuation/admission, configured-provider catalog, causal SSE projection,
  exact permission/question responses and interrupt. No terminal parser or second inference loop.
- `src/chat/nativeRuntime.ts` reuses the existing ledger and durable pickup cursor. Lost native ACKs
  reconcile by immutable native request ID without a second POST. Cursor/mailbox crash recovery
  requires positive evidence; corrupt or unresolved receipts remain held.
- Updated `docs/VISION.md`, `docs/architecture/managed-runtime-drivers.md`, the control architecture
  and `docs/decisions/2026-08-30-managed-runtime-drivers.md`. Package/binary/service names stay unchanged.
- Real isolated `scripts/opencode-runtime-e2e.ts` passed through a separate CCMux daemon and the
  public declared-service client: native external-model shell tool, one side effect, duplicate create
  and message, exact approval/input, stale-generation refusal, busy/defer, interruption/recovery,
  OpenCode → Codex → OpenCode chat with exact provider/machine/session identities, daemon restart
  preserving both provider PIDs, OpenCode restart with the same managed/native IDs, and archive.
- Focused regression coverage includes lost create/prompt replies, late native admission, missing/
  corrupt journals, cursor/mailbox crash boundaries, text deltas/roles, private errors/tool payloads,
  byte limits, CRLF SSE framing and identity/lease refusal. Packed Bun/Node/NodeNext/bundler clients pass.

## Published native slice and post-rollout evidence

- Release: `v0.39.24`; implementation `7d4d91dd21c323137c3352c6c21e3e570c658349`;
  release/tag `d78d9fc18ce33a26b13153c8529c5179b5913afe`.
- Full local gate: 831 tests, 0 failures, 3937 assertions in 128 files, plus TypeScript and packed
  consumer checks. Exact-release-SHA CI and smoke passed; tag run `33288566081` published assets.
- Runtime bundle SHA-256: `8ea40380c4b83b9870ac75072f7c8b8a714883136abbd64b7409e3ca5cff89f6`.
  Published client archive SHA-256: `e24240f88562dddfc4890971960cb80861fb722faaba73bb899a6521d18e9ab5`.
- All three owned installations converged through the existing updater to that exact bundle.
  Live daemon projections report `0.39.24`; all 33 pre-existing running sessions retained their
  managed identities and original process start times. No production session restart was needed.
- The downloaded published client successfully reads runtime capabilities and native OpenCode
  model catalogs before a chat on all three hosts. Its downloaded archive, not a local rebuild,
  passes Bun, Node, NodeNext and bundler consumer checks. Prepared control streaming returns live
  successive snapshots through the published client.
- Re-ran `scripts/opencode-runtime-e2e.ts` with `CCMUX_E2E_CLI` selecting the installed release
  bundle: the complete two-runtime tool/request/chat/restart/resume/archive sequence passed.
  A secret-like fixture was positively proved present in the real provider environment and absent
  from public metadata, process argv and outward logs. Existing production registrations are untouched.
- Reproduction: select the installed bundle with `CCMUX_E2E_CLI`, then run
  `bun --no-env-file scripts/opencode-runtime-e2e.ts`. To verify an already downloaded client archive,
  set `CCMUX_PACKED_CLIENT_ARTIFACT` and run `bun --no-env-file scripts/verify-control-service-client.ts`.
- Pre-existing interactive-session diagnostics remain visible: one delivery held for an unsent
  composer, four legacy undeclared environment sources, and an optional transit without its agent.
  They were not hidden or changed by this native adapter rollout; all daemon processes are active.

The published native slice is verified, not the entire task. The three remaining unchecked items
require the optional custom harness and are not satisfied by an unavailable capability placeholder.

## Remaining external dependency

Registry verification on 2026-08-30: published `stitchkit@0.68.11` exports neither
`stitchkit/agent-runtime/harness` nor `stitchkit/agent-runtime/coding-tools`. The owner implementation
exists but its publication is separately deferred. No unpublished checkout or copied loop is used.
The native adapter slice can ship independently; Custom remains `unavailable`, and custom coexistence,
tool acceptance and runner/SQLite integration stay unchecked. This task stays in-progress until that
published dependency is available and those real checks pass. No downstream workaround is requested.
