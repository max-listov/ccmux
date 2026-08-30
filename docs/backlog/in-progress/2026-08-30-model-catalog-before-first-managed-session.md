---
title: Read the authenticated model catalog before the first managed session
description: Remove the managed-thread bootstrap dependency from provider model discovery while preserving transport authorization.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
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
- [ ] Real installed-client acceptance and patch release evidence are recorded.

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
  and profiled catalogs before the first create. Installed release verification remains below.
