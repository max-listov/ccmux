---
title: Contract-first resident control plane and managed daemon lifecycle
description: Use Stitchkit for one bounded session-control API, live delivery and daemon resource lifecycle while retaining native session ownership.
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
related:
  - docs/backlog/done/2026-08-28-owned-codex-app-server-runtime.md
---

## Problem

Session identity, native state and durable chat already belong to CCMux. Resident clients need
one typed control surface without duplicating command validation, spawning a CLI per refresh,
or adding a second provider runtime. The daemon's independent loops need one bounded resource
lifecycle without changing the lifetime of supervised conversations.

## Result and boundaries

Stitchkit owns contract validation, local HTTP/tool adapters, bounded delivery/admission and
process-local resource ordering. CCMux retains registry transactions, native provider adapters,
exact provider/machine/session/thread identity, message receipts and session restart policy.

The local control listener uses a same-user Unix socket; no TCP listener, new account system,
provider credential copy or modified Desktop connection. Existing fleet routing stays intact.
Existing Desktop observation prerequisites remain in their own task. No consumer application
deployment or replacement inference loop is included.

## State and actions

- Application lifecycle: starting → ready → draining → stopped; failed resources are observable.
- A session's native execution state is separate from observation availability and expiry.
- A fresh full snapshot establishes the stream baseline. Subsequent absolute snapshots replace
  obsolete pending snapshots; reconnect obtains a new baseline, never a guessed event replay.
- Mutations pin the exact current identity and authenticate the caller. Durable message acceptance
  is not turn completion. Ambiguous delivery remains held by the existing receipt mechanism.
- Shutdown closes admission and resident streams and drains bounded work without stopping sessions.

## Plan

- [x] Define shared schemas/contracts and implement resident snapshot, exact-session control,
      authenticated message acceptance and native turn interruption through existing domain owners.
- [x] Expose the contract through a protected Unix listener, typed client and CLI/tool surface;
      bound bodies, caller waits, concurrency, stream frames and slow-reader memory.
- [x] Feed live snapshots from the existing observation pass without per-reader scans or polling.
- [x] Compose daemon observation, delivery, healing and control resources with Stitchkit lifecycle.
- [x] Cover identity/auth/refusal, idempotency, stale/disconnect, slow readers and shutdown races;
      validate real owned native sessions and self-contained release artifacts.
- [ ] Update reference documentation, publish a patch from the canonical checkout and verify rollout.

## Acceptance

- [x] One contract serves real HTTP and CLI/tool calls with the same schemas, errors and auth policy.
- [x] Multiple resident subscribers do not multiply provider connections or observation passes;
      immediate baseline, bounded absolute updates and explicit stale/unavailable outcomes are proven.
- [x] Wrong identity, invalid credentials, busy/approval/input states and duplicate message IDs
      cannot bypass native admission or cause unintended duplicate execution.
- [x] Real session state transitions, message receipt, native interruption and daemon restart are
      verified; supervised session identities and provider processes survive daemon shutdown.
- [x] Full gates and offline self-contained artifact checks pass. No unsupported Desktop coverage
      is claimed.
- [ ] Exact published release, asset hashes and owned-runtime parity are recorded after rollout.

## Что сделано

- `src/control/contract.ts`, `schema.ts`, `service.ts`, `auth.ts`, `message.ts` and `native.ts`
  define one typed control surface backed by the existing registry, chat journal and native RPC.
  `server.ts` binds only a protected same-user Unix socket. `src/commands/control.ts` and
  `src/control-client.ts` expose generated CLI, typed HTTP and peer-free tool-proxy consumers.
- `src/control/publisher.ts` projects the existing daemon observation into bounded absolute
  snapshots. Subscription notices coalesce; expiry invalidates positive state; disconnect and
  replacement generation remain explicit. One hundred concurrent reads plus two subscriptions
  caused no additional observation executions in the real listener test.
- `src/daemon/application.ts` uses Stitchkit resources, schedules and admission. The daemon drains
  control work and closes streams without terminating supervised conversations. A real daemon
  shutdown/restart preserved both test provider PIDs and thread identities; the reconnected stream
  received a new generation and a second exact-identity round-trip completed.
- Real native tests exposed a wait race: an older idle snapshot or advanced inbox-read cursor
  could report completion before a queued delivery. `src/control/native.ts` now requires a new
  observation after the call; `src/commands/wait.ts` checks the delivery cursor and pending receipt.
  Regression assertions cover both cases.
- `scripts/control-native-e2e.ts` exercises two distinct managed native sessions: exact A→B→A
  identity via `ccmux msg`, duplicate API acceptance, busy/defer/wait, exact-turn interruption,
  subsequent completed receipt and daemon restart. `scripts/codex-owned-safety-probe.ts` passed
  real partial-composer preservation, approval denial, input-request cancellation, interrupted
  pickup and provider restart/resume of the same identity against the candidate CLI bundle.
- `test/control.test.ts`: 9 tests / 102 assertions passed, including auth before parsing,
  replacement identity refusal, immutable message IDs, body limits, 32 slow readers, cancellation
  under a registry lock and admission drain. Full `bun run check`: 749 tests, 0 failures,
  3,139 assertions. Offline CLI and `control-client.js` tests passed with package installation,
  network registry and child-process creation unavailable to the resident client.
- `scripts/build-control-client.ts` and CI publish the self-contained reader and SHA-256 alongside
  the existing release assets. `docs/architecture/control-plane.md`, monitoring documentation,
  VISION, README and CHANGELOG describe the actual contract and its limits.

Stitchkit is pinned to 0.68.3. Unary operations use its configured HTTP client; subscriptions use
its supported Fetch-config typed client with the bounded streaming Unix transport. A reproduced
configured-HTTP-client stream cancellation defect is recorded separately in Stitchkit's
`docs/backlog/inbox/2026-08-28-http-client-stream-cancellation-after-headers.md`; this release does
not use that affected streaming construction and adds no cancellation or framing workaround.

Publication and rollout evidence is still pending; this task remains open until it is verified.
