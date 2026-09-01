---
title: Managed Codex, OpenCode and custom harness runtime adapters
description: Define one session supervision contract across structured native runtimes and an optional Stitchkit harness without owning their agent loops.
type: task
status: done
created: 2026-08-30
updated: 2026-08-31
completed: 2026-08-31T05:34:02+07:00
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
research uses the external reference harness's driver registry, continuation identity and structured OpenCode event adapter.
No UI framework, inference loop or product-owned tools/prompts are copied into CCMux.

## Execution sequence and state authority

1. Inspect the existing registry/control contracts, current the external reference harness source and the official OpenCode
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
- [x] Integrate the published optional Stitchkit harness with host-supplied configuration/tool policy
  and SQLite placement; ship a reproducible thin runner/entrypoint with an exact dependency version.
- [x] Bind plugin/driver capabilities to the published local/service clients and descriptor; no
  runtime-specific branches in the cross-machine transport.
- [x] Update lifecycle documentation, release artifacts and compatibility/rollback instructions.

## Acceptance

- [x] Codex, OpenCode and custom harness sessions coexist without writer or transcript identity collisions.
  `scripts/custom-coexistence-acceptance.ts` proves three real owners and all three exact chat edges.
- [x] OpenCode and custom harness each perform a real external-model tool turn in an isolated workspace.
  Public managed acceptance proves a signed Custom file write and authenticated three-runtime commands.
- [x] Retry preserves identity; interruption and restart/resume do not duplicate tool side effects.
- [x] Tool calls, reasoning, text, usage and terminal outcomes preserve causal order; transport closure
  alone cannot report success. Unsupported approval/input features are reported honestly.
- [x] Existing Codex/interactive session behavior is retained; no terminal scraping for new native lanes.
- [x] Real receipts identify runtime/provider/model/version. Compatibility probes of external models
  inside Codex are optional evidence, not a requirement that all providers pass through Codex.
- [x] Publish the driver/client release and report runnable examples plus remaining capability gaps.

## Dependencies

Codex fixes are published in `v0.39.23`: `../done/2026-08-30-model-catalog-before-first-managed-session.md`
and `../done/2026-08-30-managed-model-selection-and-collaboration-policy.md`. The published
`stitchkit@0.70.2` includes the Custom harness and coding-tool seam plus the sequential approval
history fix. Published-package macOS/Linux file probes and real managed acceptance pass. The
[adoption program](2026-08-30-stitchkit-069-adoption-program.md) defines its sequence,
host boundaries, exact approval-continuation mapping, packaging and combined verification.

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

The published native slice is verified. The former Custom sequential-approval publication blocker
is resolved by 0.70.2; the remaining requirement is the combined publication and rollout below.

## Remaining integration

Current qualification (2026-08-31): published `stitchkit@0.70.2`, exact source
`9df049633804ffab5daffffa2de16a40373ebdfc`, replaces the failing dependency below. The sequential
signed-approval regression and published-only probe both pass. Real candidate service acceptance
passes coding read/search/patch, observed command exits 0/7, deny/defer, pending-interrupt refusal,
active interrupt and child cleanup, plus one-writer create/message retries and worker/daemon
restart. Evidence: `68e4f68b7f3ef97baa578aa77dabd4b8e707bb09c61c08424ee688133de2ef38`.
The adoption program owns the final combined gate/publication; the following older qualification
is retained as historical reproduction, not an outstanding upstream publication blocker.

### Historical 0.70.1 qualification

Registry/archive verification on 2026-08-30 confirms `stitchkit@0.70.1` publishes
`stitchkit/agent-runtime/harness`, `stitchkit/agent-runtime/coding-tools` and the Bun SQLite store.
Exact source: `c9a86d4962178debc017a821d7034aed18bd91da`; downloaded archive SHA-256:
`6d1bacd4d84f0da5cb1317e39f9f96cffb65f3582002ab72982f97bb96b54ea0`. Export JS/types exist and the
archive matches registry integrity. No unpublished checkout or copied execution loop is needed.

The prior working tree pinned `0.70.1` and included the real installed Custom runner, immutable host
composition, exact signed response correlation, bounded native/history/image projection and
diagnostic ownership. The linked adoption program records the actual evidence: real managed
create/message retries, one signed tool continuation through worker restart, daemon restart,
vision, canonical history, applied profile and Codex → OpenCode → Custom → Codex messaging.

`scripts/custom-sequential-approval-probe.ts` reproduces the release blocker with only published
Stitchkit/AI SDK dependencies on macOS and Linux: the second accepted signed approval fails with
`AI_InvalidToolApprovalError`. The first effect exists, the second does not, and the third native
run commits `provider_failure` before model invocation. No supervisor code is needed to trigger it.
The existing Stitchkit in-progress task `2026-08-30-automatic-approval-history-chronology.md`
contains the cross-record case and a source fix with focused/packed evidence; publication is still
unchecked. Registry latest remains `0.70.1`, and release preflight repeats both failing probes.
No dependency source, signature policy or provider history is patched in this consumer.
`test/custom-multiple-approvals.test.ts` remains enabled and failing. The adoption program records
the current preflight and the dependency-publication boundary.

Historical 0.70.1 full local gate: 980 passing tests, one failing sequential-approval regression, 4,966
assertions across 165 files; Biome/TypeScript pass. All five packed-client checks pass separately.
Publication, release bump and rollout have not run. Existing production sessions are unchanged.

## Published Custom completion

The historical qualification above is superseded by `v0.39.34` with `stitchkit@0.70.2`.
Implementation `6d89daea6974fbae90e99ac9665f197e8a19dd93`, release/tag
`3258d7bb0f960fe5e9380395c35ff605364f8cfe`; full gate 993 tests / 5,069 assertions and
five packed consumers passed. Both exact-SHA CI runs `33339092883` / `33339092898` are green.
Downloaded-artifact Custom coding, signed allow/deny, restart, defer/interrupt and exact three-runtime
chat passed. The [verification artifact](https://github.com/max-listov/ccmux/releases/download/v0.39.34/post-rollout-verification.json)
records hashes, fixture cleanup and three-host parity with all 34 preexisting running sessions
preserved. All four drivers now have their actual capability boundaries; Custom does not claim
native fork, compaction, structured input requests or exact in-turn steering.
