---
title: Align the local RPC adapter with the supported door contract
description: Preserve delivery certainty and strict required response fields without introducing an inaccessible dependency.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 21:43 +0700
---

## Why

The supported local door contract is version2. Required fields must be validated, while additive
fields remain compatible. Public SDK distribution is not available; raw-door conformance is a
supported result and must not wait for a new dependency or private installation credentials.

`src/fleet/wireDoor.ts` uses bounded Unix I/O from the public framework. The raw reader must enforce
required protocol fields independently of optional SDK distribution. Remote command results and
delivery certainty are separate facts; a local HTTP reply does not prove command execution.

## Result

One supported RPC adapter preserving remote command verdict separately from transport certainty.
Public installation remains possible without private credentials, archives or neighboring checkout.

## State and integration

The existing raw door remains the transport. Before dispatch, local cancellation or unavailable
socket means `not-sent`; after dispatch without a valid verdict, delivery is `unknown`. A valid
command result means `received`; structured pre-execution refusal means `not-sent`. A door timeout
or connection loss does not prove non-execution. No arbitrary command is automatically replayed.
The immutable chat outbox remains retryable because its receiver atomically deduplicates the same ID.
This slice joins the active dependency-adoption program without changing its release boundary.

## Plan

- [x] Verify the versioned door contract and anonymous installation independently.
      Adopt an official SDK only when it is actually accessible under the project's public build
      requirements. Otherwise retain the supported raw-door path and prove conformance; do not fork
      or vendor a private SDK to make a gate green.
- [x] Require version and required response fields; tolerate additive fields but never synthesize
      success from missing failure fields. Preserve bounded response and deadline behavior.
- [x] Carry not-sent/unknown/received or equivalent explicit certainty through RemoteResult and
      real callers. Trace reachability before changing user messages or claiming a live defect.
- [x] Preserve configured route choice, with no silent fallback to another transport on uncertainty.
- [x] Preserve existing outbox envelope IDs and atomic receive deduplication. Retries of that
      idempotent owner operation are not equivalent to replaying arbitrary remote commands.
- [x] Cover malformed versioned replies, after-dispatch timeout, capacity/permanent refusal,
      truncation, cancellation and concurrent receive deduplication.

## Acceptance

- [x] Public frozen installation remains credential-free and self-contained.
- [x] Missing required response fields cannot produce a successful command result.
- [x] Unknown is not reported as definitely unsent; no new automatic retry of arbitrary writes.
- [x] Session/message behavior and idempotent delivery survive the adapter change.
- [x] SDK availability decision is explicit; lack of public distribution is not bypassed or
      used to prevent independent correctness fixes in the raw-door client.

## Что сделано

- [x] `src/fleet/wireProtocol.ts` is the single required-field door2 reader. Version mismatch,
      malformed replies and additive keys are distinct. A live raw-door read passed: code 0,
      delivery received and 33,455 stdout bytes.
- [x] `src/fleet/transport.ts`, `src/fleet/wire.ts`, `src/commands/msg.ts` and `src/fleet/flush.ts`
      carry certainty through CLI/outbox callers. Mutation relays warn against blind replay.
- [x] `test/wire-required-fields.test.ts` failed before the fix and now rejects each individually
      omitted required field. `test/wire-certainty.test.ts` covers bounds, classifications, truncation,
      pre/post-dispatch cancellation, positive-dispatch deadline and no fallback/replay.
- [x] `test/wire-chat-retry.test.ts` executes the real receiver in separate processes. A committed
      first delivery loses its reply; two concurrent retries preserve byte-identical envelopes,
      append once and settle the existing outbox. Exact-target/message regressions also pass.
- [x] Combined focused gate: 56 tests, 265 assertions, zero failures across nine files. Biome and
      TypeScript pass; packed install/Bun/Node/NodeNext/bundler checks all pass.
- [x] Anonymous SDK registry lookup returns HTTP 404. No private SDK dependency is added.
      Frozen installation from copied public manifest/lock installs 166 packages, with lifecycle
      scripts ignored and no extra artifact or neighboring source checkout.
- [x] `docs/architecture/control-plane.md` and `docs/architecture/peer-routing.md` document the
      parser, delivery certainty and distinct idempotent owner retry boundary.

Local qualification bundle SHA-256:
`48e0935ca35364fad2297bb22cfdf813f3822647c567fa469dfbb99a02c2ae56`.
Live raw-door log SHA-256:
`19e99711454385a6616da3597d01351245fc05daa830de8bc415605fa18ff3b3`.
Focused gate log SHA-256:
`ecfabafbef77e4076ff952a9a7c4e5fbdfb7eedb1bc79140f772d85063dc5829`.

This local conformance result is complete, not a publication receipt. Combined publication stays in
`../in-progress/2026-08-30-stitchkit-069-adoption-program.md`: 980 full-suite tests pass and its
enabled upstream sequential-approval regression fails. No new release/tag or runtime change is claimed.
