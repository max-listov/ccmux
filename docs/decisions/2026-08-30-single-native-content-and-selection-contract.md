---
title: One native content and selection contract
description: Separate durable turn admission, observed native configuration and bounded replay without retaining obsolete client interfaces.
type: decision
status: active
created: 2026-08-30
updated: 2026-08-30
---

## Decision

Use one unversioned control surface and one native stream profile. The required service-envelope
revision is the literal `current`; it does not negotiate multiple public API versions. Internal
durable-format guards and native provider protocol versions retain their validation semantics.
Local Unix control and
authenticated remote service ingress call the same domain operations; transport differences are
not parallel client semantics. Retire superseded endpoints and update owned callers together.

Create selection remains immutable idempotency input. A revisioned selection journal holds future
defaults. Each accepted message pins effective typed options; changing defaults never rewrites
accepted work, and an override never changes future defaults. Native settings/assistant/reroute
events provide separate observed evidence. Requested values alone do not establish native application.

OpenCode primary-agent selection must agree with immutable application policy during admission,
before either the selection journal or message ledger changes. Codex model/mode/effort choices do
not widen process credentials, sandbox or approval authority.

Content is a bounded observation cache produced by the existing native writer. One current frame
carries cursor-relative records or an explicit reset baseline, independently from monitoring.
Native history remains authoritative. Slow readers may receive a gap; they must replace their
baseline and process terminal/request entries there as well as in deltas. No complete-transcript
claim follows from a successful subscription.

Text records have exact native item/turn identity, revision and UTF-8 byte offsets. Native item
completion is distinct from retained-text completeness: a truncated completed item still rejects
late nonterminal deltas. Completed native Plan items reconcile their earlier Plan deltas through the
same assistant-content kind. Private reasoning and raw tool payloads are not part of this contract.

Prepared native leases and settings can change without a content sequence. Subscription deduplication
therefore covers the combined public metadata, not just content cursors. One shared one-second lease
check and post-publication filesystem notices wake readers; no reader starts a provider poller.
The stream producer must not heartbeat an expired live lease.

## Consequences and evidence

- Durable identities, accepted inputs and native history survive restarts; no compatibility endpoint
  is needed to preserve them.
- Explicit revision CAS and shared native admission serialize selection against messages/context.
- The replay cache has fixed item/record/byte limits and bounded subscriber notices; history has a
  separate bounded request and cancellation deadline.
- Public contract details and runnable acceptance programs are in
  [native content and turn controls](../architecture/native-content-and-turn-controls.md).
- Regression coverage: `test/content-buffer.test.ts`, `test/content-store.test.ts`,
  `test/codex-selection-evidence.test.ts`, `test/policy-selection-admission.test.ts`.
- Native selection E2E uses actual settings/assistant metadata; text E2E compares reconstructed
  content to native history, including a slow reader. These are not model self-reports.
