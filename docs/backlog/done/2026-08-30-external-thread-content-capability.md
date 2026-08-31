---
title: Typed external thread transcript and control capability discovery
description: Expose bounded external conversation reads and explicit control eligibility without adopting or competing with a live writer.
type: task
status: done
created: 2026-08-30
updated: 2026-08-31
completed: 2026-08-31T05:34:02+07:00
priority: P1
---

## Evidence

Published client 0.39.33 exposes external inventory/status, while `ControlTargetSchema` accepts
`ManagedPeerSchema` and `controlTarget` resolves only registered managed sessions. The CLI
`transcript` command also uses `findSession(loadSessions(...))`; an observed external thread is
not a registered session. The native harness roadmap explicitly excludes official Desktop
attachment. A consumer can display an observed external thread but cannot request its bounded
transcript through the public service contract. Monitoring evidence does not grant write access.

## Result

Provide owner-typed content availability and a bounded paginated transcript read for exact external
identities, across the current service composition. Distinguish unavailable/history-absent/stale
from empty history, expose resume/change evidence and preserve source identity. Do not require
consumers to read provider files, invent filesystem routes or impersonate a managed target.

Control eligibility must be explicit per operation. If the provider supports sending to the existing
writer through a documented authorized path, expose that path with exact identity, idempotency
and delivery evidence. Otherwise return unsupported with no side effects. Automatic adoption,
takeover, another app-server writer, permission escalation and terminal injection are out of scope.

## Implementation plan

The configured provider storage is the read authority, not a managed registration or a new
App Server. Add `external.capabilities` and `external.history` to the existing local/service
contract. Exact provider/machine/thread identity selects a bounded owner-side lookup; no caller
path is accepted. Read only ordinary same-user files without following storage symlinks.

History is a newest-first page selection returned in chronological order. Versioned cursors
paginate older content; file replacement or append invalidates the cursor explicitly. Cap source
bytes, directory discovery, records, text and response size; report omitted/partial content.
Only authored user/assistant text is projected, never internal prompts, tool arguments/results,
reasoning or inline media. This is not full native transcript fidelity.

This content grant provides no mutation authority. External message/interrupt/respond/fork/compact
remain explicitly unsupported by this service; the existing managed and external chat ownership
paths are unchanged. Test real service ingress, exact identity, private-path exclusion, corrupt
and stale cursors, empty history, symlink/access refusal, and reads while an existing writer lives.

## Acceptance checks

- [x] Published client/descriptor expose external content capability and bounded read schemas.
- [x] Local/remote reads preserve exact external identity and report truncation/resume explicitly.
- [x] Existing Desktop writer remains unchanged; read does not start, resume, adopt or fork.
- [x] Unsupported control is a typed outcome; supported control proves one writer and no replay
  after unknown delivery. Do not claim native support without a real provider probe.
- [x] Regression tests include missing identity, access refusal, stale cursor, no content and
  a running external thread. Return version/SHA, public entry points and evidence.

## Что сделано

`src/external/content.ts` and `contentSchema.ts` implement the fixed-root bounded authored-text
projection. Local/service operations share admission, validation and current configuration checks.
Changed roots or revoked access fail closed until restart without blocking unrelated operations.
The typed client, descriptor and packed consumer probes expose the same two operations.

Nine targeted tests pass with 73 assertions, including actual Unix/service ingress and policy
revocation. A built-candidate probe read a real live Desktop thread: three entries, 2,149 response
bytes, explicit older cursor, exact unchanged writer lock and no managed registration. All five
control capabilities remain unsupported. Evidence SHA-256:
`b748c8a550ea094579b51d6b385b6b9475088385f3fc5e721be8f9d2827ce076`.
No conversation body or exact private identity is included in the evidence output. Published
artifact and cross-machine service acceptance remain required; local ingress is not remote proof.

## Published completion

`v0.39.34`, implementation `6d89daea6974fbae90e99ac9665f197e8a19dd93`, release/tag
`3258d7bb0f960fe5e9380395c35ff605364f8cfe`. Full gate: 993 tests / 5,069 assertions;
five actual downloaded packed-client consumers and both exact-SHA CI runs passed.
After the existing transport's two broker lanes received the two exact read grants, the downloaded
client read a real remote Desktop conversation: two entries / 2,182 response bytes, explicit older
cursor and truncation, unchanged exact writer lock holder. An unauthorized target returned
`denied / not-dispatched`. No CLI/SSH content gateway, takeover, provider restart or message was used.
Read policy was enabled on the execution host without changing provider/notification configuration.
The primary installation's read policy is also enabled: its actual daemon and downloaded local
client returned three entries / 2,149 bytes for a live Desktop thread. Evidence SHA-256:
`f3c73eae391adfcf255792a46a4cdecfeaee30ac024cc4b32d70957db2ebe9dc`.
Evidence SHA-256: `a734000c916fc4ee486c29d972748f14af1bd764d745f394c8c8edcb569ba3f7`.
Public operations are `external.history` / `external.capabilities`; all external mutations remain
explicitly unsupported. Three-host parity, artifact integrity and exact checks are in the
[verification artifact](https://github.com/max-listov/ccmux/releases/download/v0.39.34/post-rollout-verification.json).
