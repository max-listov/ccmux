---
title: Custom Harness owns canonical execution behind managed admission
description: Compose the published headless engine without duplicating its store, approval state or execution loop.
type: decision
status: active
created: 2026-08-30
updated: 2026-08-30
---

## Decision

The existing supervisor, registry, immutable host recipe and chat admission remain the control
authority. A single per-registration Stitchkit Harness and SQLite store own Custom execution.
Provider choice, tools, resources and executable authority are execution-host declarations;
the public client never sends credentials, paths or module loading instructions.

An approval-producing native run is terminal but its managed message is not complete. The accepted
answer starts a new canonical tool-input run. Public bounded continuation evidence preserves both
the original binding and each real successor; response fingerprints make later retries exact.
There is no synthetic merged run, independent tool journal or consumer-side execution retry.

Snapshots/content/history adapt the canonical engine once into current contracts. Unsupported
operations are explicit capabilities. Event gaps force reconciliation; uncertain prior side
effects are held. Diagnostic journals are finite process evidence, not durable delivery authority.
Private observability retains actual failures while public projections expose generic outcomes.

The CLI packages the exact runner and contained-files native assets as immutable verified bytes.
The normal checkout remains the only release source. No runtime imports a dependency source tree.

## Qualification boundary

Real managed creation, first signed approval/reopen, images and three-runtime messaging pass
against the current working tree. Sequential signed approvals are blocked by the published
Stitchkit 0.70.1 history validator. The failing regression stays enabled; removing signatures,
patching provider history in this adapter or shipping partial approval support is not accepted.
Publication and rollout require the corrected dependency and complete integrated acceptance.

See [architecture](../architecture/managed-runtime-drivers.md) and the
[adoption program](../backlog/in-progress/2026-08-30-stitchkit-069-adoption-program.md).
