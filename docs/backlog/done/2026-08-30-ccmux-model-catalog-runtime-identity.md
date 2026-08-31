---
title: Model catalog must identify the selected execution runtime
description: Return explicit execution-runtime identity for every accepted runtime-selected catalog read.
type: task
status: done
created: 2026-08-30
updated: 2026-08-31
completed: 2026-08-31T05:34:02+07:00
priority: P1
related: docs/backlog/done/2026-08-30-managed-native-and-custom-runtime-adapters.md
---

## Problem

In the released0.39.33 service client, a successful `model.list` with `runtime: "codex"`
can return a host source containing `kind`, `machine` and `provider`, but no `runtime`.
The active contract requires runtime in native/custom host and session sources. The released
omission is a contract completeness mismatch, not a malformed transport reply.

Owner-local reproduction: read the authenticated host catalog with an explicit Codex selector
through the published client and assert `page.source.runtime === "codex"`; repeat for an exact
managed session. An OpenAI provider does not establish Codex runtime identity: provider and
execution runtime are distinct selectors. No model inference or synthetic managed session is
needed for host discovery.

## Result and scope

Every accepted explicit runtime selector yields a catalog with matching execution-runtime
identity, independent of provider identity. All native/custom source constructors and public
clients follow one contract. This is a focused follow-up to the completed
`docs/backlog/done/2026-08-30-model-catalog-before-first-managed-session.md`, not its reopening.
Coordinate the shared source files with the active runtime-adapters task; do not implement the
same change twice. No transport, private caller configuration or external consumer change.

## Plan

The existing `src/control/models.ts` dispatcher is the single owner of runtime selection. This
slice makes every catalog source require its selected runtime, including the Custom constructor
already present in the active adapter implementation. No parallel catalog or execution path is added.

- [x] Verify the omission against current source and published client; reuse any already completed
      owner implementation and record its exact release rather than duplicate it.
- [x] Define the required runtime identity when an explicit selector is accepted, for both host
      and session scope; update schema and every native/custom catalog constructor together.
- [x] Reject mismatched target/runtime before dispatch. Never infer runtime from provider name
      or label an unknown identity as the requested runtime without checking its source.
- [x] Add deterministic packed-client coverage for explicit runtime selection, host/session scope,
      mismatch refusal and stable source identity across pagination.
- [x] Return exact release/artifact and actual installed acceptance under the owner's release
      authority, or an explicit contract decision if the proposed requirement is incorrect.

## Acceptance

- [x] Typed host catalog works before the first managed session and identifies its selected runtime.
- [x] Exact session reads cannot be mislabeled as another runtime's catalog.
- [x] Provider identity and runtime identity remain separate; missing optional model metadata stays unknown.
- [x] Public client/descriptor and owner runtime agree; public installation needs no private inputs.
- [x] Record exact checks and release result; do not claim consumer UI acceptance on its behalf.

## Что сделано

- [x] `src/control/schema.ts` requires source.runtime and validates session source against target
      runtime/machine. `src/control/models.ts` names Codex in both constructors; existing OpenCode
      and Custom constructors retain their own identity. No provider-based inference.
- [x] `test/control-models.test.ts` covers explicit session selection, stable pagination, mismatch
      refusal before provider contact, absent runtime and optional metadata. The bootstrap test
      proves an empty registry and metadata-process cleanup.
- [x] `scripts/verify-control-service-client.ts` qualifies all three runtimes at host/session scope
      through packed Bun/Node clients, required typing and malformed/mismatched refusal.
- [x] `scripts/control-models-e2e.ts` reads a real native catalog with no managed registration:
      runtime codex, provider openai, seven visible/two hidden models, stable pagination and safe
      metadata. The downloaded 0.39.33 client confirms its installed host response omits runtime.
- [x] `docs/architecture/control-plane.md` records the required source identity.

Qualification client artifact (not published): 58,677 bytes, SHA-256
`9643ac8080c8fab828aa8ac48dd80c5fe4c82d69e2c7588d20a1bd6f6de96811`.
Install, Bun, Node, NodeNext and bundler gates pass. Focused checks: 56 tests, 265 assertions.
Full check passes Biome/TypeScript and 980 tests; the known Stitchkit 0.70.1 sequential-approval
regression alone fails. Full gate log SHA-256:
`b42873f04e6467038f9c637d87e5177de9fc08159d88d7841668f6c4b57aa26a`.
Real catalog log SHA-256:
`b8d86adbdefcfdc4591a4afedcebc08c78ed663c1ff9a251c95b2ac987092cf9`.

Release and installed-artifact acceptance stay open in the existing adoption program. HEAD/tag
remains `a6e683ed5a900627439eb97e1a8a63c7680f5bee` / `v0.39.33`; no separate implementation SHA
exists yet. The independently verified fix is in the canonical working tree. No consumer code,
configuration or production runtime is changed.

The combined 0.70.2 pre-publication gate supersedes the historical failed gate: Biome/TypeScript,
993 tests with 5,069 assertions and all five packed consumers passed. SHA-256:
`9b4c4202dfd72f2d40679f019c6e7a7c1447b88ca8fbb6fce7882ced5f2a4e3d`.

## Published completion

`v0.39.34`, release/tag `3258d7bb0f960fe5e9380395c35ff605364f8cfe`, implementation
`6d89daea6974fbae90e99ac9665f197e8a19dd93`. Both exact-SHA CI runs passed. The actual
downloaded client passed all five consumers and read the live remote host catalog through the
declared service: `runtime=codex`, `provider=openai`, nonempty first page and continuation cursor.
Evidence SHA-256: `2afd253df90fbbaddd1385217e687b2d5458da1d08a7c208149764f68f5a7404`.
Three-host version/hash parity and public archive integrity are recorded in the
[verification artifact](https://github.com/max-listov/ccmux/releases/download/v0.39.34/post-rollout-verification.json).
No consumer UI or consumer dependency was changed or claimed verified.
