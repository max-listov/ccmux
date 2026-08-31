---
title: Native model and collaboration selection within an existing session
description: Change runtime-supported model and interaction options without changing managed identity or rewriting an immutable launch recipe.
type: task
status: done
completed: 2026-08-30 13:02 +07:00
created: 2026-08-30
updated: 2026-08-30
priority: P1
pipeline: native-harness-control
order: 3
depends-on: —
related: ../done/2026-08-30-managed-model-selection-and-collaboration-policy.md
---

## Why

`ControlCreateSchema` accepts `modelSelection`, but `ControlMessageSchema` cannot select a model or
interaction mode for an existing conversation. Current launch/model stamps correctly preserve
create-time identity and Plan selection; clients must not bypass those checks or rewrite recipes
to obtain native in-session behavior.

T3's [turn input](https://github.com/pingdotgg/t3code/blob/8dcb96314c976899e4df6951fb9af03131c2a46f/packages/contracts/src/provider.ts)
carries model selection and interaction mode, and its
[adapter contract](https://github.com/pingdotgg/t3code/blob/8dcb96314c976899e4df6951fb9af03131c2a46f/apps/server/src/provider/Services/ProviderAdapter.ts)
distinguishes in-session model switching from unsupported operation. Native runtime identity,
inference provider selection, launch authority and user interaction mode are different concepts.

## Result and state

A typed operation updates persistent session selection defaults with an expected selection revision.
A message may carry explicit per-turn options; an override does not silently become a new default.
Both paths use the same bounded schema, catalog validation and driver capability checks. Preserve
the managed UUID, native continuation and one writer. No second profile per model is required.

State: `current revision → validated intent → applied/effective` or `rejected/uncertain`. Serialize
selection changes against native admission. New persistent defaults apply between turns; a busy or
waiting-request session is refused explicitly rather than changed mid-turn. A queued message pins
its effective options when accepted, so a later selector change cannot rewrite deferred work.

The immutable create fingerprint remains the original operation, not the mutable current default.
Late create retries return that same identity without resetting later selection. Recovery uses
the durable accepted selection revision; an indeterminate native change requires reconciliation.

## Plan

- [x] Specify supported model, reasoning-effort and collaboration/interaction fields and their
  defaults. Preserve native provider differences rather than treating Codex Plan and an OpenCode
  agent option as identical policy. Validate against the connected runtime's current capabilities.
- [x] Extend driver/control/client/descriptor contracts with exact revision/operation IDs and safe
  receipts that distinguish requested, accepted and native-effective selection.
- [x] Implement between-turn defaults and explicit per-turn options using structured native calls.
  Preserve owner credentials, sandbox/approval policy and immutable recipe authority. A native
  option requiring another provider, process or authentication context refuses in-session change.
- [x] Update mailbox/journal admission to pin effective options and reconcile failed or lost replies.
  Extend launch-stamp/recovery checks deliberately; do not disable mismatched-model protections.
- [x] Preserve model selection across Plan/default-mode changes; use provider-owned mode instructions,
  not product prompts. Report unsupported options before message admission, not after a silent fallback.
- [x] Document typed options, concurrent update semantics, queue behavior and capability differences;
  update architecture and a runnable published-client example.

## Acceptance

- [x] Real Codex and OpenCode sessions each switch between two available native models without a
  new managed/native identity. Native evidence, not the model's prose, establishes effective selection.
- [x] Session-default change and per-turn override have distinct tested behavior. A subsequent ordinary
  turn uses the persisted default, and delayed work uses the options accepted with that message.
- [x] Codex Plan/default transitions retain selected model/effort and exact native input responses.
  OpenCode mode options are exercised only where its native configuration actually supports them.
- [x] Concurrent stale-revision updates, duplicate operation IDs and changed payload retries refuse
  or reconcile deterministically. Busy, approval/input, unavailable model and provider mismatch fail closed.
- [x] Daemon/provider restart preserves the latest accepted default; late create retry does not roll
  it back. Create-only and text-only input work through the single current contract, without old-client branches.
- [x] Packed Bun/Node clients, complete local gates, exact-SHA CI and real session E2E pass. Record
  release/artifact hashes and verify owned-runtime rollout with the published client.

## Boundaries

No account/provider credential management, arbitrary config strings, new agent prompts/tools or
runtime conversion. This extends the completed create-time selection task, not reopens it.
See the [native control roadmap](2026-08-30-native-harness-control-parity.md).

## Что сделано

- [x] `src/runtime/selection.ts`, `src/control/selection.ts` and message admission pin revisioned
  effective options; `src/agent/codex/selectionEvidence.ts` separates native settings/reroute evidence.
- [x] `scripts/native-selection-acceptance.ts`: 16 real native turns, two models per runtime;
  default/override/defer/CAS, Plan, exact input/approval and provider/daemon restart passed.
  Evidence SHA-256: `c61806f52b053969837be7ede9c3f65d217f63bd5dd067c6096f02958def3f74`.
- [x] `test/policy-selection-admission.test.ts` proves a conflicting OpenCode policy agent or source
  drift refuses before ledger/default mutation, while the authorized or omitted agent passes.
- [x] Contract and decision: `docs/architecture/native-content-and-turn-controls.md`,
  `docs/decisions/2026-08-30-single-native-content-and-selection-contract.md`.
- [x] Published `v0.39.25`: implementation `3c7235454e657cefa5ec570d6fb4c927293b07e4`,
  release `2cc132e3e1bb1235d5dba967d7ba39655b8a58b1`; exact-SHA CI run
  [33295298409](https://github.com/max-listov/ccmux/actions/runs/33295298409) passed.
  Runtime bundle SHA-256: `3de1dc4e00afae0f7af1030068aa8d9e67a9ac8d2bfcd20374fdc2687b83e0ff`.
  Downloaded client archive SHA-256: `4ab1717877b4c154eaae3a84810656628d8043ce978266c7299ab42b4b0df72d`.
  The actual published archive passed installation, Bun/Node and both TypeScript resolution checks.
  All three owned runtimes reported this exact version/hash and live owner projections; existing
  managed identities and running sessions were preserved. Local native service revision 2 reads
  passed on both remote execution hosts; cross-machine transport activation remains a separate
  unresolved acceptance boundary in the roadmap.
