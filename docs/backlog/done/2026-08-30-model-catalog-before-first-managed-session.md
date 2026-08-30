---
title: Read the authenticated model catalog before the first managed session
description: Remove the managed-thread bootstrap dependency from provider model discovery while preserving transport authorization.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 08:18 +07:00
priority: P1
---

## Problem

In v0.39.22 `ControlModelsReadSchema` requires an exact managed target. A consumer must select a
provider model before creating its first thread, but cannot read the model list without an existing
thread. Inventing a target, reviving an archived session or creating a placeholder conversation
solely for discovery is not acceptable.

`src/control/models.ts` validates `controlTarget` and then uses `connectCodexAppServer(machine)`.
That connector reads the machine-level App Server socket, not the selected managed-session socket.
A real read against a retained stopped target succeeded and returned the machine catalog. The
target therefore gates access without being the actual catalog source. This is a scope mismatch
to resolve explicitly, not evidence that the existing provider read fails.

## Result

- Scope is native Codex App Server catalog discovery. This does not make CCMux a generic inference
  proxy, model aggregator, or host for unrelated agent loops. The service owner publishes its
  descriptor; the cross-machine transport must not contain model-specific routing code.
- Authenticated host/provider-scoped typed catalog discovery is available with no managed rows.
- The catalog source/runtime scope is explicit. If per-session discovery is retained, it reads the
  exact session runtime and cannot claim another runtime's response as that session's catalog.
- Consumer-supplied executables, endpoints, credentials, arbitrary paths and fake identities remain
  forbidden. No inference turn is started for discovery.
- Publish updated local/service clients and descriptor; preserve bounded pagination, deadlines,
  cancellation and safe metadata. Missing context-window metadata stays unknown.

## План

- [x] Expose host recipe discovery without a thread; retain exact-runtime reads for explicit managed targets.
- [x] Bound a metadata-only native process by caller admission, deadline and cleanup; never call thread/start.
- [x] Record source identity and test isolation, empty inventory, cancellation and published clients.

## Acceptance checks

- [x] Empty managed inventory can list authenticated models before creating the first chat.
- [x] Stopped/archived targets are not needed for bootstrap.
- [x] Two differently configured runtimes cannot cross-label their catalog responses.
- [x] Real installed-client acceptance and patch release evidence are recorded.

## Что сделано

- `src/agent/codex/catalogRuntime.ts` owns a short-lived metadata-only native process and bounded
  private diagnostics. `src/control/models.ts` separates host discovery and exact session sockets.
- Local and declared-service schemas/clients publish explicit source metadata, native model IDs,
  bounded pages and cancellation without caller paths or executable configuration.
- `test/control-model-bootstrap.test.ts` verifies empty inventory, no thread RPC, process-group
  cleanup and refusal before spawn. `test/control-models.test.ts` proves runtime isolation and
  refuses to label OpenAI picker metadata as a custom-provider catalog.
- Real native `scripts/control-models-e2e.ts`: 7 visible and 2 hidden models; pagination, safe fields,
  no managed row before or after the read. The declared-service acceptance also reads both default
  and profiled catalogs before the first create.

### Published and installed acceptance

- [x] Implementation `1353706170a5685af27342761f516e3930529d07`; release
  [`v0.39.23`](https://github.com/max-listov/ccmux/releases/tag/v0.39.23), exact SHA
  `80258c0947b3b1d2a575934e335aaaa76e0b2a9f`. Release and push gates passed: 814 tests,
  0 failures, 3,855 assertions; packed Bun, Node, NodeNext and bundler consumers all passed.
- [x] Exact-SHA [release CI](https://github.com/max-listov/ccmux/actions/runs/33285015429)
  and [main CI](https://github.com/max-listov/ccmux/actions/runs/33285015204) succeeded.
- [x] `scripts/control-model-selection-acceptance.ts` ran against the installed release bundle
  and extracted, checksum-verified published service-client package. Its initially empty inventory
  returned seven native models through the declared service before any session existed; it then
  completed native model selection, tool execution, input response, restart and archival checks.
- [x] All three owned installations report version `0.39.23`, live monitoring and the same bundle
  SHA256 `db5a72f8cfa6968ee1ad243d3c4c73360a6ea9eda598eedee36e2e491952b661`.
  Each installed host catalog returned seven models; all 33 pre-existing running sessions retained
  their UUID and running state. No private launch profiles or consumer configuration were changed.
- [x] Published service-client archive SHA256:
  `d9e9c946d747b51be34046b4a40c22ccda8d216a54ab228740e65b63d3edf086`.
  Standalone local client SHA256:
  `7ba96f1bacb83b8cfd886ff2a1b0ae0f1ab3935d35285ff62c6935e5866db4b9`.

The native acceptance has no remaining blocker. This is not a blanket clean-fleet diagnosis:
existing operational diagnostics also report legacy undeclared environment inputs in four unrelated
interactive sessions, one held message at a nonempty composer, and an unavailable optional transit
route. This work does not change those sessions' environment, clear their input or configure transit.
