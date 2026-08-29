---
title: Control service effect identifiers must satisfy the transport descriptor contract
description: Make the published control descriptor activatable by the canonical declared-service policy instead of passing only its owner-local schema.
type: task
status: done
created: 2026-08-29
updated: 2026-08-29
completed: 2026-08-29 13:10 +0700
priority: high
depends-on: v0.39.17 control service ingress
---

## Problem

The published revision-1 descriptor cannot be parsed by the canonical declared-service descriptor
schema. All nine effects contain `:`, for example `session:read`, while an effect identifier must
match `/^[a-z0-9][a-z0-9._-]*$/`. Operator activation therefore fails before writing policy, even
though the owner-local `ControlServiceEffectSchema` accepts the descriptor.

The release acceptance exercised a local/service adapter but did not parse the exported descriptor
through the actual transport-neutral service policy schema. A consumer must not rewrite effects:
the exact descriptor effect is an authorization identity enforced by broker and target.

## Result

- Publish a descriptor whose service, revision, operations, effects and limits pass both the CCMux
  owner schema and the canonical declared-service descriptor schema unchanged.
- Keep owner ingress authorization and typed client metadata on the same exact effect strings.
- Define the compatibility policy for the already-published broken revision: either correct
  revision 1 when no valid activation was possible, or publish a new revision and migration note.

Compatibility policy: retain revision 1. The published colon-delimited descriptor cannot pass the
canonical policy parser, so no valid activation or grant migration exists. Once a revision has a
valid activation, changing any effect identifier requires a new revision.

## Plan

- [x] Replace colon-delimited effects with valid stable identifiers and update ingress/client
      metadata from one source of truth.
- [x] Add a regression that feeds the exported descriptor into an independent structural schema
      with the canonical service/revision/operation/effect/limits bounds.
- [x] Run packed Bun/Node/NodeNext/bundler checks and a real operator-policy activation preflight,
      not only an injected-fetch service call.
- [x] Publish a patch and report exact version/SHA/artifact integrity plus the activation receipt.

## Acceptance

- [x] Every exported operation/effect identifier matches `/^[a-z0-9][a-z0-9._-]*$/`.
- [x] The release `descriptor.json` and package export are byte-equivalent after JSON framing and
      pass the external policy parser without translation.
- [x] Exact operation/effect mismatch still fails closed at ingress and authorization.
- [x] A dry-run activation of all nine operations succeeds without editing the descriptor.

## Что сделано

- [x] Contract: `src/control/serviceDescriptor.ts` defines one dot-delimited effect mapping for
      descriptor validation, client metadata and service operation lookup; revision 1 remains the
      canonical unactivated revision.
- [x] Package: `src/control-service-client.ts` exports the mapping, while
      `scripts/verify-control-service-client.ts` proves packaged `descriptor.json` parity through
      Bun, Node, NodeNext and bundler consumers outside the source checkout.
- [x] Policy compatibility: `test/control-service-policy.test.ts` independently encodes the
      transport bounds and identifier grammar. The canonical operator dry-run accepted all nine
      operations without descriptor translation or config mutation; a mismatched effect was
      denied.
- [x] Owner behavior: `test/control-service.test.ts` retains strict operation selection, nested
      selector refusal, response bounds, stale request refusal and shared admission coverage.
- [x] Documentation: `docs/architecture/control-plane.md` records the revision/effect stability
      rule and `CHANGELOG.md` records the patch. The terminal release report carries the exact
      release commit, artifact digest, activation receipt and owned-runtime parity.
