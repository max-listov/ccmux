---
title: One unversioned pre-release control surface and a shared Biome gate
description: Keep one current public control path and enforce a consistent repository-wide code style without publishing a release.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30
priority: P1
---

## Why

The pre-release control surface has numbered route and stream-profile names despite supporting
only one current implementation. The repository also lacks a formatter/linter gate. Both make
ongoing contract changes harder to review consistently.

## Result

One unversioned public control surface, no numbered aliases or compatibility dispatch, and pinned
Biome with the shared Bun-project style: two spaces, 100 columns, single quotes and semicolons.
Durable format validation, native provider protocols and one-writer guarantees remain intact.

## Plan

- [x] Replace numbered public names and update the descriptor, client, tests and living architecture.
- [x] Add Biome configuration, package commands and the same quality gate to local checks and CI.
- [x] Resolve formatting/lint findings, verify the full local gate and document exact results.
- [x] Clarify that local implementation/readiness does not authorize a release.

## Acceptance

- [x] The one current ingress and stream profile work through the typed client; numbered aliases
  refuse, cursor identity validation remains strict, and packed Bun/Node consumers pass.
- [x] Biome checks source, tests and scripts without warnings or automatic gate-time mutation;
  TypeScript and the complete test suite pass.
- [x] Existing reviewed index bytes are preserved. Package version and HEAD stay unchanged;
  no commit, push, tag, release, rollout or production runtime change is performed.

## Boundary

Local implementation and verification only. Historical published acceptance records remain true
to their released artifacts. No consumer repository or running service is changed.

## Что сделано

- [x] `src/control/serviceCatalog.ts`, `serviceIngress.ts` and `nativeStreamContract.ts` expose
  `/ccmux/control`, `/ccmux-control/invoke`, `ccmux-native` and the `ccn_` cursor prefix. The required
  service revision is the literal `current`. `test/control-unversioned.test.ts` and
  `test/control-service.test.ts` reject numbered descriptors/routes/cursors and retain exact identity
  validation. No compatibility dispatcher was added; durable and upstream format guards remain.
- [x] `biome.json`, `package.json` and `bun.lock` pin Biome 2.5.11 and the shared style. Safe formatting
  and import organization cover the repository. Explicit control flow replaces comma returns;
  fixture checks replace unchecked assertions. Intentional terminal control-byte matching and
  stateless terminal rows have localized documented lint exceptions, not disabled rule groups.
- [x] `scripts/control-service-acceptance.ts`, `external-resident-e2e.ts` and
  `verify-external-turns.ts` preserve the original failed assertion instead of replacing it with a
  cleanup error thrown from `finally`. Successful runs still fail when cleanup fails.
- [x] `.github/workflows/ci.yml`, `.githooks/pre-push`, `README.md`, `CLAUDE.md` and living control/
  development architecture describe the same read-only quality gate and local-only release boundary.
- [x] `bun --no-env-file run check` exited 0: Biome checked 504 files with no fixes or diagnostics;
  TypeScript passed; 931 tests and 4,576 assertions across 148 files passed. Packed installation,
  Bun, Node, NodeNext and bundler resolution all exited 0. Focused contract checks separately passed
  37 tests and 182 assertions. `git diff --check` passed.
- [x] Package version remains `0.39.26`; HEAD remains
  `24cdb31e2997e4deea9e0e36ee992bc1da71d782`. The test-only package archive was not published.
  No staging, commit, push, tag, rollout or production service operation was performed.
