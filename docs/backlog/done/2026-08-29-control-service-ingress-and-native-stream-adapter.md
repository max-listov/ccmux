---
title: Published control service ingress and native stream adapter
description: Carry the typed local control contract through a declared remote service boundary without copying schemas or starting another provider writer.
type: task
status: done
created: 2026-08-29
updated: 2026-08-29
completed: 2026-08-29
priority: high
depends-on: v0.39.16 project-scoped control surface
---

## Problem

`ccmux/control-client` is intentionally same-user Unix IPC. A remote typed consumer can route a
declared owner service through an existing fleet transport, but the control server does not expose
the fixed owner-service ingress envelope or descriptor that such a binding requires. Binding the
control socket directly is invalid because its HTTP routes and authorization framing differ from
the service ingress contract.

A consumer-side CLI/JSON gateway would copy operation mapping, effects, budgets and stream framing.
It would also make transport code responsible for a domain contract that CCMux already owns.

## Result

- Publish a versioned CCMux-owned service descriptor and fixed private Unix HTTP ingress for the
  bounded unary control operations needed by remote consumers: idempotent create, exact get/native
  read/respond, message/start/interrupt/wait and archive.
- Dispatch only the trusted outer service operation, then validate its payload and result with the
  existing control schemas. Reuse the resident control services; do not add a registry mutation
  path or provider writer.
- Publish a headless native-stream adapter that uses `ccmux/control-client`, emits schema-valid
  bounded NDJSON snapshots and preserves generation/sequence/reset semantics. It must be suitable
  for a fixed allowlisted stream profile without consumer-owned parsing or arbitrary argv.
- Export descriptors, schemas and typed composition helpers from the published package/bundle for
  Bun and Node consumers. Socket paths, credentials and private workspace data stay operator-owned.

## Plan

- [x] Define service revision, per-operation effects and exact request/response/deadline budgets.
- [x] Add the fixed service-envelope ingress beside the existing local control server, reusing
      canonical handlers and admission rather than proxying through the CLI.
- [x] Add the fixed native snapshot stream adapter with bounded frames, heartbeat/cancellation and
      explicit initial/generation/gap reset behavior.
- [x] Export a self-contained descriptor/client surface and document the operator binding/profile
      contract without naming a private consumer or fleet path.
- [x] Cover idempotent retry, delivery uncertainty, stale request refusal, stream reconnect/gap,
      cancellation, oversize and managed shutdown in packed Bun/Node consumers.

## Acceptance

- [x] A declared remote service call produces the same typed receipt as local
      `ccmux/control-client`; ambiguous idempotent create retry still has one writer.
- [x] Native snapshots retain exact target, generation, sequence, pending request identity and
      reset reason across adapter reconnect.
- [x] Unknown operation, wrong revision/effect, copied nested operation, oversized payload/frame
      and stale response identity fail closed.
- [x] No arbitrary shell, consumer-supplied socket/path/argv, provider credential, second writer or
      private consumer context enters the public API or artifacts.
- [x] Release result includes version, exact SHA, packed artifact integrity and one real managed
      session service/stream acceptance.

## Что сделано

- `src/control/operations.ts`, `service.ts` and `serviceIngress.ts` place local IPC and the strict
  declared-service envelope over one operation surface and one pair of mutation/wait admissions.
  The outer operation is selected before its existing control schema parses the payload; every
  result is validated and bounded before reply.
- `src/control/serviceDescriptor.ts` and `src/control-service-client.ts` publish revision 1, nine
  exact effect/budget entries, a transport-injected typed client and composition metadata. The
  client opens no connection and never retries a mutation on its own.
- `src/control/nativeStreamContract.ts` and `src/commands/controlNativeStream.ts` publish the fixed
  no-argv/no-env stream profile, target-bound cursor codec and bounded stable-cursor NDJSON producer.
  Initial, matching resume, generation and gap resets remain the canonical native projection;
  heartbeat repeats the same frame/cursor and SIGINT/SIGTERM close the local reader.
- `scripts/package-control-service.ts` produces the release tarball, JSON descriptor/profile,
  declarations and SHA-256 receipt. `scripts/verify-control-service-client.ts` installs the fresh
  tarball outside the checkout; Bun runtime, Node runtime, NodeNext and bundler gates all pass.
  Two consecutive packages had identical bytes and digest.
- `test/control-service.test.ts` covers strict revision/operation/effect/payload refusal, copied
  nested selector, response bounds, stale native identity, shared admission/drain, one writer after
  ambiguous create, local/service parity and initial/heartbeat/resume/gap/cancellation framing.
  The full owner gate passes 771 tests with 3,597 assertions.
- `scripts/control-service-acceptance.ts` ran through the installed candidate against one newly
  created real managed Codex App Server session. The service/local create receipts converged on one
  identity, duplicate retry was explicit, an exact message completed with its expected reply,
  native pending was empty, stream reset changed `initial` to `null` on resume with zero duplicate
  items, and exact archive left no running probe session. Output hashes identity/generation and
  never records the operator workspace or session name.
- `docs/architecture/control-plane.md`, `docs/VISION.md`, `CHANGELOG.md` and the CI release asset list
  document and publish the owner boundary. The terminal release report carries the final version,
  commit SHA, tarball digest, managed acceptance and owned-runtime parity; no consumer identity or
  operator configuration enters the public repository or artifacts.
