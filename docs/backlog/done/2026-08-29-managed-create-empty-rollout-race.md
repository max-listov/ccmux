---
title: Managed create must tolerate the rollout metadata publication boundary
description: Prevent a transient zero-byte Codex rollout from permanently failing an idempotent managed create receipt.
type: task
status: done
created: 2026-08-29
updated: 2026-08-29
priority: high
completed: 2026-08-29 13:57 +0700
depends-on: v0.39.18 project-scoped control surface
---

## Problem

A real `session.create` can observe the newly created Codex rollout after the file exists but before
its first metadata record is readable. The bootstrap then fails with `thread-store internal error:
failed to read session metadata ... rollout ... is empty`. The durable create receipt becomes
`failed`, no managed session is promoted, and replaying the same request correctly preserves that
failure.

This is a publication race inside the managed bootstrap boundary. A consumer cannot recover it by
minting another request ID without weakening create idempotency and hiding a failed writer attempt.

## Result

- Managed create treats a matching zero-byte/uninitialized rollout as transient only within the
  existing bounded correlation budget.
- A genuinely corrupt or permanently empty rollout still fails with bounded internal evidence.
- The request receipt reaches one stable terminal state and never creates a second writer.

## Plan

- [x] Identify the provider-native point at which rollout metadata becomes committed for reading.
- [x] Keep correlation pending across the transient empty-file state without accepting an unrelated
      rollout or extending the existing timeout indefinitely.
- [x] Add a deterministic race regression that exposes the file before its first metadata record.
- [x] Run repeated real managed creates through the declared service and archive every probe.
- [x] Publish a patch with exact release and repeated installed-runtime acceptance; the terminal
      release report records the tag, commit and artifact digest.

## Acceptance

- [x] A rollout file visible before its first record no longer permanently fails `session.create`.
- [x] Retrying the same request returns one target and `duplicate: true` with one writer identity.
- [x] A permanently empty/malformed rollout fails within the correlation deadline and leaves no
      running or pending probe.
- [x] Existing adopt/fork correlation and create rollback tests remain green.

## Что сделано

- `src/agent/codex/resume.ts` defines the provider publication boundary as the first complete,
  newline-terminated `session_meta` record whose UUID matches the requested thread. Missing, empty,
  partial, malformed and mismatched metadata remain pending within the existing correlation budget.
- `src/agent/codex/ownedConnection.ts` keeps the first initialization turn as the action that causes
  rollout publication. Only the provider's named pre-dispatch `thread-store` empty-metadata failure
  waits for the committed boundary and retries once with the same immutable client message ID. An
  exact persisted-ID check prevents a second submission after an uncertain reply.
- Deterministic tests expose a zero-byte rollout before metadata, verify the same-ID retry, and keep
  permanently empty/malformed cases bounded. Adopt, fork, rollback and exact-correlation regressions
  remain green.
- Three independent installed release-candidate runs created one managed writer each through the
  declared service, reconciled the duplicate receipt to the same exact identity, delivered the exact
  reply, completed `wait`, resumed the native cursor and archived the probe. No live probe or pending
  create remained afterwards.
