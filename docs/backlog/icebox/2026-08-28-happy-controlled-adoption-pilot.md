---
title: Evaluate Happy as the interactive client for an owned agent fleet
description: Run an isolated Claude and Codex pilot to decide whether to adopt Happy, integrate its control plane, or reuse only selected patterns.
type: task
status: icebox
created: 2026-08-28
updated: 2026-08-28
defrost: The maintainer explicitly requests evaluating adoption of Happy as a product rather than borrowing architecture patterns.
related:
  - docs/research/2026-08-28-happy-and-codexmonitor.md
  - docs/backlog/in-progress/2026-08-28-owned-codex-app-server-runtime.md
---

## Why

This adoption pilot is not part of the accepted CCMux implementation. The selected direction is
direct ownership of native provider runtimes in CCMux, borrowing selected event/recovery patterns
without installing Happy. The pilot below remains a separate, explicitly frozen alternative.

Happy offers a shared interface for Claude and Codex, remote machines, encrypted messaging and
mobile access. This overlaps the planned interactive fleet client enough that an adoption test
should precede building another complete application. Repository inspection is not operational
acceptance: package provenance, current provider compatibility, status freshness and recovery
must be measured on the same pinned artifacts.

## Result

A reproducible adopt / integrate / reuse-only decision, supported by a small live pilot and a
rollback record. Existing production conversations, provider credentials and repository checkouts
remain unchanged. A successful pilot is not permission to migrate every session.

## Plan

- [ ] Choose the exact product lane: classic `happy claude` / `happy codex` plus encrypted
      relay, or current Happy Desktop plus the separate `slopus/happy-agent` daemon. The latter
      is a replacement harness, not a wrapper around the native Codex App Server. Do not mix
      their session identities, APIs, privacy claims or recovery guarantees in one result.
- [ ] Pin the Happy CLI, server and client versions separately. Verify registry provenance and
      artifact integrity. The registry package named `happy-agent` observed on 2026-08-28 is a
      different project from `slopus/happy/packages/happy-agent`; do not install it by name.
- [ ] Specify the pilot state directory, transport, binding, account pairing and allowed data
      before launch. Do not change existing environment values, URLs or ports implicitly.
      Prefer a self-hosted, synthetic-data pilot; do not silently enroll production credentials
      or private workspaces into a hosted relay. Record build/runtime compatibility explicitly.
- [ ] Start one disposable Claude conversation and one disposable Codex conversation, then
      exercise a second machine. Use the normal project checkout or an explicit test fixture;
      do not make a second development/release clone. Compare Happy web/desktop and mobile
      clients where available; record any platform that was not tested.
- [ ] Trace provider ID + machine ID + Happy session ID through send, reply, approval, input,
      interruption, disconnect and resume. Test two concurrent senders and message retry;
      distinguish persisted, delivered, started and completed acknowledgements.
      For the replacement harness, record its own identity separately: a Happy session is not
      a resumable native Codex thread. Assess subscription authentication and native feature
      fidelity without presenting provider-shaped prompts as first-party execution.
- [ ] Compare UI status with provider events and process liveness. Measure completion latency,
      lost-host expiry, reconnect ordering, CPU/RSS and observer cost over at least 15 minutes.
      Inspect `happy-agent wait` separately from UI thinking/presence; do not assume parity.
- [ ] Stop only pilot processes, restart the pilot daemon/provider, resume the same provider
      identity and repeat the round trip. Verify recovery after client exit and machine restart
      in a disposable environment; do not reboot a shared host as a test.
- [ ] Review pairing/revocation, stored keys, plaintext presence metadata, analytics, push and
      optional voice. Verify the exact privacy settings of each selected client; ordinary
      encrypted sync does not make voice context end-to-end encrypted.
- [ ] Record the decision and implementation boundary. If the Happy client is unsuitable,
      evaluate CodexMonitor as the Codex-only desktop alternative, not a second full fleet
      migration. Record exact versions and any required upstream fixes.

## Acceptance

- [ ] Both providers complete same-identity round trips across the tested clients and machines;
      identity refers to the selected harness, explicitly distinguishing native Codex thread
      IDs from replacement-harness IDs. A title or path is never identity evidence.
- [ ] Working, idle, permission/input waits and disconnected/stale are distinguishable;
      recorded measurements establish whether freshness meets the existing 5-second contract.
- [ ] Busy, duplicate send, disconnect and denied approval cannot produce false delivery or
      completion. A mismatch is a measured adoption gap, not silently accepted success.
- [ ] The selected runtime's identity survives its supported restart/resume path. For classic
      native-provider sessions, verify both provider and Happy IDs; for the new harness, verify
      Happy identity and explicitly record that native Codex resume is not established.
      An in-flight process restart is not represented as uninterrupted execution.
- [ ] Privacy and artifact provenance are documented; no production account, session or setting
      is changed by the pilot. Cleanup leaves production sessions and the review index intact.
- [ ] Publish an anonymized evidence report and explicit recommendation. Mark untested paths
      untested. This task does not claim existing official Desktop-thread coverage.
