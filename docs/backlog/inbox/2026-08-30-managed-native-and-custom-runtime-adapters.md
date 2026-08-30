---
title: Managed Codex, OpenCode and custom harness runtime adapters
description: Define one session supervision contract across structured native runtimes and an optional Stitchkit harness without owning their agent loops.
type: task
status: inbox
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

- [ ] Specify the common contract/state machine and supervisor vs runtime ownership before adapters.
- [ ] Preserve current Codex catalog/selection work; consume its release without resetting identity.
- [ ] Implement managed OpenCode server startup or explicit adoption, authenticated SDK control,
  native session resume, tool/request mapping and bounded streaming. An externally owned server
  must never be stopped as a child owned by CCMux.
- [ ] Integrate the published optional Stitchkit harness with host-supplied configuration/tool policy
  and SQLite placement; ship a reproducible thin runner/entrypoint with an exact dependency version.
- [ ] Bind plugin/driver capabilities to the published local/service clients and descriptor; no
  runtime-specific branches in the cross-machine transport.
- [ ] Update lifecycle documentation, release artifacts and compatibility/rollback instructions.

## Acceptance

- [ ] Codex, OpenCode and custom harness sessions coexist without writer or transcript identity collisions.
- [ ] OpenCode and custom harness each perform a real external-model tool turn in an isolated workspace.
- [ ] Retry preserves identity; interruption and restart/resume do not duplicate tool side effects.
- [ ] Tool calls, reasoning, text, usage and terminal outcomes preserve causal order; transport closure
  alone cannot report success. Unsupported approval/input features are reported honestly.
- [ ] Existing Codex/interactive session behavior is retained; no terminal scraping for new native lanes.
- [ ] Real receipts identify runtime/provider/model/version. Compatibility probes of external models
  inside Codex are optional evidence, not a requirement that all providers pass through Codex.
- [ ] Publish the driver/client release and report runnable examples plus remaining capability gaps.

## Dependencies

Codex fixes are published in `v0.39.23`: `../done/2026-08-30-model-catalog-before-first-managed-session.md`
and `../done/2026-08-30-managed-model-selection-and-collaboration-policy.md`. OpenCode implementation and
driver-contract work can proceed independently. Custom driver waits only for the published
Stitchkit harness seam; agree that boundary through the existing owner-task handoff process.
