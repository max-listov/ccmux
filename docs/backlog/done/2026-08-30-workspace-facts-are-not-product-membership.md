---
title: Distinguish execution workspace facts from product and repository membership
description: Clarify the public control and fleet contract without turning filesystem location into product identity.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 22:29 +0700
priority: P2
---

## Why

Read-only source review finds no product-to-repository cardinality restriction in managed control.
`src/control/schema.ts` accepts an absolute workspace; `normalizeWorkspace` in
`src/control/lifecycle.ts` resolves an existing directory without requiring a Git root.
`src/config/sessions.ts` and `src/control/target.ts` select and validate sessions by their explicit
managed identity, not by directory or product name.

The comment on `RemoteSessionSchema.dir` in `src/commands/fleetList.ts` nevertheless calls the
directory a checkout identity and describes longest-path-prefix product matching. A directory
alone proves neither repository identity nor product membership. `docs/architecture/control-plane.md`
describes workspace-scoped create without explicitly stating this boundary. The existing
`docs/architecture/peer-routing.md` already forbids routing by cwd or product name.

## Result

One documented interpretation of workspace/dir: an execution-location fact, not a Product Project,
Repository, Checkout identity or harness workspace membership. Product-to-repository membership
is explicit and many-to-many; consumers own that private catalogue. A private companion can be
part of the same product, while a dependency alone grants no membership. This clarification does
not add a product catalogue, repository discovery or a new project identifier to CCMux.

## Scope

The bounded follow-up covers semantics/docs and generic regression cases only. Scheduling,
control execution and product registries are unchanged. Tests use disposable directories and
stub only the provider launch, not the real registry or create transaction. Publication, index
changes and historical records are outside this follow-up; preserve the current release work.

- [x] Clarify the dir comment in `src/commands/fleetList.ts` and the workspace boundary in
      `docs/architecture/control-plane.md`; align peer-routing terminology where necessary.
- [x] State that the canonical-checkout release rule governs this repository's working copy,
      not the number of repositories allowed in a product.
- [x] Qualify the existing contract with generic non-Git-directory and shared-workspace cases,
      preserving explicit session identity and create idempotency without adding membership inference.

## Acceptance

- [x] The reviewed control/fleet contract and examples do not treat a cwd, path prefix, dependency
      or harness project label as authoritative product/repository membership.
- [x] Multiple exact session identities may share one workspace; non-Git workspaces remain valid.
- [x] The changed documentation contains no private membership catalogue, companion paths or return addresses.
- [x] Record actual verification separately from this source-only audit; no live topology claim
      is inferred from an inspected test fixture.

## Что сделано

- [x] `src/commands/fleetList.ts` documents dir as an execution fact only. No executable code changed.
- [x] `docs/architecture/control-plane.md`, `docs/architecture/peer-routing.md` and `CLAUDE.md`
      distinguish workspace, session identity, repository identity and explicit many-to-many product membership.
- [x] `test/control-workspace-semantics.test.ts` exercises the real create transaction/registry:
      non-Git directory, normalized same-ID retry, changed-workspace conflict, distinct registrations
      sharing cwd and refusal of a mixed identity. Strict create rejects undeclared membership fields.
      Only provider launch is stubbed; no live session or scheduling/control implementation is changed.
- [x] Targeted command `bun --no-env-file test test/control-workspace-semantics.test.ts
      test/control-lifecycle.test.ts test/control-directories.test.ts` passes eight tests and 45 assertions.
      TypeScript and Biome exit zero. Biome reports one pre-existing informational template-style
      diagnostic in `test/wire-chat-retry.test.ts`; no unrelated fix is applied.
- [x] Existing `src/control/lifecycle.ts`, `src/control/schema.ts` and `src/config/sessions.ts`
      retain their pre-follow-up SHA-256 bytes. No full-suite rerun, index update, commit or release.
