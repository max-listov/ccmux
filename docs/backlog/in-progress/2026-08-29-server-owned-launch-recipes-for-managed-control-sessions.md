---
title: Server-owned launch recipes for managed control sessions
description: Let trusted control callers select an immutable host-defined Codex launch policy without sending paths, commands, credentials, or secret values.
type: task
status: in-progress
created: 2026-08-29
updated: 2026-08-29
priority: P1
related:
  - docs/architecture/control-plane.md
  - docs/architecture/launch-recipe.md
  - docs/decisions/2026-08-28-owned-native-codex-runtime.md
---

## Why

The public control surface can create a default managed Codex App Server session, while the
execution host already owns the session environment, native configuration and durable launch
identity. A trusted caller still has no safe way to select one of those owner-defined launch
policies. Sending an env-file path, executable, shell fragment or credential through
`session.create` would move authority to the caller and create a second environment mechanism.

## Requested result

- [x] Add an immutable recipe reference to public `session.create`; requests contain no arbitrary
      path, executable, shell text, credential or secret value.
- [x] Resolve recipes only from execution-host configuration and reuse the existing `envFile`,
      session environment, native Codex flags, launch stamp and transactional managed create.
- [x] Bind create idempotency and the durable managed identity to recipe id plus immutable
      revision/digest; changed, removed or unavailable recipes fail closed before spawn or registry
      mutation.
- [x] Expose only safe recipe metadata and capabilities in create receipts and status/native
      projections; never expose values, env-file contents or private paths.
- [x] Preserve the same recipe and managed identity across reconciliation and daemon/provider
      restart, including late retry without a second writer.
- [x] Keep recipe-less managed creation backward compatible.
- [x] Update the typed local/service clients, descriptor, architecture/decision documentation and
      packed Bun/Node consumer coverage.
- [x] Prove a default create, a generic external-provider recipe, secret non-disclosure, same-id
      retry, unknown/changed fail-closed behavior, restart reconciliation and the existing native,
      message, wait, approval/input, interrupt and archive surfaces.
- [ ] Pass the full local gate and exact-SHA CI, publish the next patch and verify every owned
      runtime on the released version and artifact hash.

## Что сделано

- `bun run check`: 787 tests, 0 failures; typecheck and packed Bun/Node service-client gates pass.
- The real no-recipe control-service path created one native App Server writer, reconciled local and
  service retries, completed an exact model reply and wait, resumed the native cursor, and archived.
- A separate real managed session preserved partial input, deferred across approval/input waits,
  accepted exact responses, interrupted and recovered, then restarted and resumed the same UUID.
- The isolated host-recipe path kept its secret-like fixture out of the request, receipt, status,
  native projection, service log and provider argv. Same-request, provider-restart and daemon-restart
  retries retained one identity and digest; unknown, edited and removed definitions failed closed.

## Boundary

The recipe is configuration data owned by the execution host. It selects the existing native Codex
harness; it does not add an inference proxy, a second provider writer, caller-authored environment,
or a consumer CLI gateway.
