---
title: Bounded local RPC transport and optional typed-client adoption
description: Remove unbounded local response plumbing while preserving public installation and existing delivery semantics.
type: task
status: inbox
created: 2026-08-28
updated: 2026-08-28
priority: P2
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

- [ ] Audit current call sites, response sizes, deadlines, cancellation, version parsing,
      refusalIsPermanent and mapping into RemoteResult. Record real traffic bounds without payloads.
- [ ] Verify whether a released typed client is independently installable under this project's
      public distribution constraints. Inspect its actual exported API and import graph, not its name.
- [ ] Select the smallest supported implementation: released accessible client when permitted,
      otherwise the documented local API with existing public bounded Unix I/O primitives.
      Do not invent a generic plugin system or a new SDK merely for this migration.
- [ ] Keep package source/build independent of restricted repositories and credentials.
      Do not vendor restricted implementation into a public bundle or change visibility/license.
      If adoption specifically requires a new distribution decision, report that exact blocker;
      bounded transport work can continue independently.
- [ ] Bound streamed response bytes before JSON parsing, include body completion in the deadline,
      preserve per-call cancellation/resource cleanup and reject oversized/truncated replies explicitly.
      Do not replace existing budgets with an SDK default without compatibility evidence.
- [ ] Preserve node-address selection, optional transport configuration, command results,
      policy/request/capacity distinctions and existing outbox responsibility.
      A possibly-dispatched timeout must not become permission to replay a command.
- [ ] Remove superseded plumbing only after parity; keep the public local-API compatibility
      contract covered even when a library is used. No automatic SSH or command retry fallback.
- [ ] Run project gates, isolated public install/package checks and real allowed RPC checks.
      Under the accepted owner release mandate, publish and verify owned runtimes; do not
      restart or migrate provider sessions to validate a transport library.

## Acceptance

- [ ] Fresh public checkout/package install and import require no private repository access,
      pre-populated cache, token file or restricted artifact.
- [ ] A large/stalled body reaches a bounded terminal outcome; cancel/timeout releases the
      reader/socket/admission slot and cannot retain unbounded memory.
- [ ] Additive response fields are tolerated; unsupported version, malformed required fields,
      unknown failure values, owner exit, policy/request/capacity refusal remain distinguishable.
- [ ] Unavailable local socket does not start a daemon, discover credentials or switch transport.
- [ ] Existing session identity, durable message/outbox policy and command behavior are unchanged.
- [ ] Actual declared RPC before/after and negative fixtures prove parity; benchmark claims
      use comparable measured workloads, not the presence of a library.
- [ ] Record implementation choice, dependency/artifact versions, gates, release/runtime proof
      when applicable, and any remaining optional-client adoption blocker.
- [ ] Documentation/changed source contain no private consumer names, paths or coordination addresses.

## Возврат результата

Report the exact result, selected supported client path, release evidence and remaining blockers
to the maintainer. External coordination addresses belong outside this public repository.
