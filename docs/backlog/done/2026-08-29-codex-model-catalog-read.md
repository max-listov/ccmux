---
title: Read the Codex model catalog through the control service
description: Expose the provider-owned Codex App Server model/list response as a bounded typed control read.
type: task
status: done
created: 2026-08-29
updated: 2026-08-29
completed: 2026-08-29 17:43 +0700
priority: high
---

# Read the Codex model catalog through the control service

## Problem

Consumers that create managed Codex App Server sessions need to show the models offered by the
authenticated Codex runtime. The current control surface exposes session lifecycle and native
projection, but not the provider-owned `model/list` method. Consumers therefore either hardcode a
model list or invent a second provider transport. Both choices make the catalog stale and can select
an id the authenticated runtime does not offer.

## Result

Add a read-only, typed control operation that forwards the official Codex App Server `model/list`
contract and returns a bounded, safe catalog. The operation must preserve provider ownership: it
reads the connected runtime's current models and does not accept a model registry, credentials,
paths, argv or executable configuration from the caller.

The provider contract was verified against a real connected App Server (codex-cli 0.147.0) before
implementation: `{cursor?, limit?, includeHidden?}` → `{data: Model[], nextCursor: string|null}`.
The control operation is `POST /control/models` (contract key `models`, tool name `models`),
declared-service operation `model.list` under the additive dot-form effect `model.read` in the
existing revision-1 descriptor, with typed methods on both published clients.

## Acceptance

- [x] Descriptor, schemas and service/client exports are typed and read-only.
- [x] Pagination, page and payload limits, cancellation, deadline and provider errors are covered
      by regression tests.
- [x] A real connected App Server returns its current catalog through the published client, with no
      credentials, paths, argv or private machine configuration in the response.
- [x] The operation is available from the normal installation and the public package artifact.
- [x] Full checks and a published patch release are green. Patch release **v0.39.22** published
      2026-08-29T10:38:24Z from commit `ef8bc461d5c3105880848e0ef3d892160a6fcd96` (tag `v0.39.22`):
      both CI runs (main + tag) succeeded, the release carries the atomic manifest+bundle pair
      (manifest sha256 `3593727e…` = actual `ccmux.js` sha256) plus reader/control/service-client
      assets and `install.sh`; fleet self-update verified live on all owned runtimes.

## Boundaries

This task does not proxy arbitrary provider APIs, create sessions, choose a model on behalf of a
caller, or expose Desktop-owned stdio tasks. A consumer remains responsible for its own product
catalog projection and must fail closed when this read is unavailable.

## Что сделано

- [x] Contract: `src/control/schema.ts` defines `ControlModelsReadSchema` (strict `cursor` ≤ 4 KiB,
      `limit` 1–64 default 64, `includeHidden`), `ControlModelSchema` and
      `ControlModelCatalogSchema` (≤ 64 models, nullable `nextCursor`); `src/control/contract.ts`
      declares the idempotent `models` route with typed input/output.
- [x] Handler: `src/control/models.ts` performs the read-only `model/list` call against the
      connected App Server of one exact owned session (`controlTarget` + `isOwnedCodex`), maps the
      provider page onto the safe bounded DTO, and fails closed with `UNAVAILABLE` on provider
      errors, malformed or oversized pages; the caller supplies no registry, credentials, paths,
      argv or executable configuration.
- [x] Operations: `src/control/operations.ts` runs the read under a new global read admission
      (4 concurrent, 5-second caller budget) mapped through `controlRefusal` to `BUSY`/`TIMEOUT`/
      `CANCELLED`; `src/control/service.ts` wires it into the local and declared-service surfaces.
- [x] Declared service: `src/control/serviceDescriptor.ts` adds operation `model.list`, effect
      `model.read` (limits 4 KiB / 256 KiB / 10 s), input/output schemas and the typed endpoint;
      `src/control/serviceIngress.ts` dispatches it. Existing effect identifiers are unchanged, so
      revision 1 remains canonical and the tenth operation is additive.
- [x] Exports: `src/control-client.ts` and `src/control-service-client.ts` publish the schemas and
      types; the descriptor ships through `scripts/package-control-service.ts` unchanged.
- [x] Regression tests: `test/control-models.test.ts` (12 tests) covers safe-metadata-only output,
      deterministic provider-cursored pagination, strict input bounds, `includeHidden`, identity and
      runtime fail-closed refusals before provider contact, malformed/oversized payload refusal,
      provider error and disconnect refusal, handler bounds (provider extras dropped, optional
      efforts honored, >64-page refusal, cancellation), declared-service envelope/effect dispatch,
      `RESPONSE_TOO_LARGE` over the 256 KiB service budget, read admission `BUSY`, client
      cancellation and the 5-second `TIMEOUT`. `test/control-service-policy.test.ts` pins the
      ten-operation descriptor.
- [x] Provider E2E: `scripts/control-models-e2e.ts` ran against the live App Server
      (codex-cli 0.147.0): 7 visible + 2 hidden models, default `gpt-5.6-sol`, two-page cursor
      round-trip, safe fields only, no machine configuration in the response.
- [x] Package: `bun scripts/verify-control-service-client.ts` passed install, Bun, Node, NodeNext
      and bundler gates for the artifact containing the ten-operation descriptor.
- [x] Checks: `tsc --noEmit` clean; `bun test` 803 pass / 0 fail across 121 files.
- [x] Documentation: `docs/architecture/control-plane.md` records the `models` route, read
      semantics, `model.read` effect and read-admission bounds; `CHANGELOG.md` records the change.

Release note: implementation and every pre-release gate are complete; the remaining acceptance
item is the published patch release itself, reserved for the maintainer's explicit command.

## Что сделано в релизе

- [x] Release v0.39.22 (`ef8bc46…`, tag `v0.39.22`) published via CI (gate → build → publish,
      runs `33248235677`/`33248235772` both green); manifest `release.json` sha256 matches the
      published `ccmux.js` byte-for-byte.
- [x] Rollout verified on owned runtimes: local `m5`, `prod` (ML-PROD) and `dev` (ML-DEV) all
      report `release.current = latest = 0.39.22` with `ok: true`, daemons active after
      self-update; `ccmux control --help` lists the new `models` command from the installed
      bundle.
