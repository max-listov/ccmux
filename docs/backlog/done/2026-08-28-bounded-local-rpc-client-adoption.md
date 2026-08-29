---
title: Bounded local RPC transport and optional typed-client adoption
description: Remove unbounded local response plumbing while preserving public installation and existing delivery semantics.
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
priority: P2
completed: 2026-08-29 13:57 +0700
pipeline: owner-client-composition
order: 2
depends-on: Optional external-client adoption requires an accessible supported artifact
---

## Зачем

`src/fleet/wire.ts` implements local Unix RPC using fetch, its own reply parser and a
fully buffered response text. The local API is versioned, while the application owns routing,
session identity and message delivery. This is a concrete place to verify bounded I/O and
evaluate a typed client without coupling public installation to a restricted dependency.

This task is independent of provider-runtime, Desktop attachment and session-control work.

## Результат

Local RPC reads are bounded and cancellable, version/refusal/outcome semantics are preserved,
and a fresh public checkout installs/builds without private registry credentials or artifacts.
There is one selected production transport path, not a stack of hidden fallbacks.

A typed-client migration is conditional on distribution compatibility. A supported
dependency-free door adapter using existing public I/O primitives is a legitimate alternative,
not evidence that an inaccessible SDK was adopted.

## План

- [x] Audit current call sites, response sizes, deadlines, cancellation, version parsing,
      refusalIsPermanent and mapping into RemoteResult. Record real traffic bounds without payloads.
- [x] Verify whether a released typed client is independently installable under this project's
      public distribution constraints. Inspect its actual exported API and import graph, not its name.
- [x] Select the smallest supported implementation: released accessible client when permitted,
      otherwise the documented local API with existing public bounded Unix I/O primitives.
      Do not invent a generic plugin system or a new SDK merely for this migration.
- [x] Keep package source/build independent of restricted repositories and credentials.
      Do not vendor restricted implementation into a public bundle or change visibility/license.
      If adoption specifically requires a new distribution decision, report that exact blocker;
      bounded transport work can continue independently.
- [x] Bound streamed response bytes before JSON parsing, include body completion in the deadline,
      preserve per-call cancellation/resource cleanup and reject oversized/truncated replies explicitly.
      Do not replace existing budgets with an SDK default without compatibility evidence.
- [x] Preserve node-address selection, optional transport configuration, command results,
      policy/request/capacity distinctions and existing outbox responsibility.
      A possibly-dispatched timeout must not become permission to replay a command.
- [x] Remove superseded plumbing only after parity; keep the public local-API compatibility
      contract covered even when a library is used. No automatic SSH or command retry fallback.
- [x] Run project gates, isolated public install/package checks and real allowed RPC checks.
      Under the accepted owner release mandate, publish and verify owned runtimes; do not
      restart or migrate provider sessions to validate a transport library.

## Acceptance

- [x] Fresh public checkout/package install and import require no private repository access,
      pre-populated cache, token file or restricted artifact.
- [x] A large/stalled body reaches a bounded terminal outcome; cancel/timeout releases the
      reader/socket/admission slot and cannot retain unbounded memory.
- [x] Additive response fields are tolerated; unsupported version, malformed required fields,
      unknown failure values, owner exit, policy/request/capacity refusal remain distinguishable.
- [x] Unavailable local socket does not start a daemon, discover credentials or switch transport.
- [x] Existing session identity, durable message/outbox policy and command behavior are unchanged.
- [x] Actual declared RPC before/after and negative fixtures prove parity; benchmark claims
      use comparable measured workloads, not the presence of a library.
- [x] Record implementation choice, dependency/artifact versions, gates, release/runtime proof
      when applicable, and any remaining optional-client adoption blocker.
- [x] Documentation/changed source contain no private consumer names, paths or coordination addresses.

## Что сделано

- The optional typed client is not independently distributable to this public package. The selected
  production path therefore keeps CCMux's versioned reply schema and uses the already-public
  `stitchkit@0.68.5` Unix client transport for bounded I/O. No restricted source, artifact, registry
  or credential enters install, source, tests or the bundle.
- `src/fleet/wireDoor.ts` owns one Unix connection per request with 8 MiB request, 52 MiB response,
  64 KiB header, zero-redirect and one-connection limits. One deadline covers headers and complete
  body consumption; success, refusal, limit, timeout and caller cancellation all close the transport.
- `src/fleet/wire.ts` retains routing, API-version comparison, additive-field tolerance and exact
  command results. Policy/request refusals are permanent, capacity is temporary, unknown classes
  remain unknown, and no failure triggers an automatic command retry, daemon start or SSH fallback.
- Real pre-release traffic on both configured remote readers returned valid three-machine snapshots
  through the existing one-peer declared route: roughly 8.8 KiB in four seconds, zero stderr and no
  identity or command-shape change. Negative real-socket fixtures cover missing sockets, oversized
  and stalled bodies, malformed fields, unsupported versions and every refusal/outcome class.
- Full candidate gate: TypeScript, 782 tests with 3,667 assertions, and an isolated packed-client
  install/import through Bun, Node, NodeNext and bundler resolution. The terminal release report
  records the exact patch, artifact integrity and post-rollout parity.

## Возврат результата

Report the exact result, selected supported client path, release evidence and remaining blockers
to the maintainer. External coordination addresses belong outside this public repository.
