---
title: Preserve message origin and explicit notification audience
description: Separate authenticated ingress, attributed author and human notification intent across admission, durable chat records and their projections.
type: task
status: in-progress
created: 2026-08-31
updated: 2026-08-31
---

## Why

In 0.39.34, declared-service `message.send` in `src/control/serviceIngress.ts` calls
`operations.message` with `cliPrincipal(invocation.caller)`. The authenticated caller is a
machine identity, not proof that the author used a terminal, is a particular human, or is an
agent. An application submitting a human's input consequently creates a CLI-labelled record.

`src/chat/telegram.ts` mirrors every unmirrored ledger message, while `src/chat/fleetLog.ts`
projects structured endpoints into `from`/`to` strings and drops the message ID. A received
`kind: chat` record means receipt by the destination, not that a human should be notified.
Consumers cannot make correct audience decisions from those strings.

Generic reproduction: an authenticated application on host-A submits a user's prompt to a
managed agent through the declared service. The prompt is delivered, but the sender becomes
`cli`, the prompt is echoed to the configured Telegram recipient, and feed consumers lack
structured origin/audience evidence to distinguish this from a human-directed notice.

## Result

One current typed contract distinguishes transport/authenticated ingress, attributed author,
application/channel context and notification audience/intent. The accepted durable message is
the authority; delivery, provider prompt framing, chat projections and notification adapters
preserve its meaning. This task does not introduce a product registry, second agent runtime,
human identity service, or general-purpose messaging platform.

Ordinary human input to an agent is conversation/audit data, not an automatic notification back
to that human. Agent-to-agent coordination is not automatically a human notification either.
Explicitly human-directed notices remain possible under host-owned policy. Notification intent
does not grant execution authority or change provider permission modes.

## Plan

- [x] Resolve the minimal trusted boundary using existing service authentication and host-owned
  policy. Document what is verified and what is only an application's attributed author.
  A client-provided human/name/from field is not proof; a machine principal alone does not prove
  an application or human. Reject unauthorized provenance claims rather than promote them.
- [x] Define one strict input/envelope/projection contract. Keep exact managed target,
  registration generation and provider identity. Separate author, ingress and notification
  semantics; do not overload router `onBehalfOf` or infer membership from workspace/path.
- [x] Persist accepted provenance and audience with messageId. Bind them into duplicate and
  conflicting-retry validation: an identical retry cannot submit twice or escalate its audience.
  Update native prompt framing so application input is not falsely described as a CLI invocation
  or a peer agent; preserve the distinction between attribution and permission.
- [x] Expose messageId and structured origin/audience through snapshot and resumable feed, with
  the same semantics for local/remote and sent/received projections. Labels are derived only.
- [x] Apply audience policy in the existing Telegram mirror before delivery. A deliberately
  suppressed record advances the cursor without being called delivered or blocking later notices.
  Preserve transient/permanent failure behavior; no global chat/mirror disable as the fix.
- [x] Specify an explicit bounded handling/migration of existing durable records. Do not invent
  missing human provenance, replay history as new notifications, reset cursors or delete accepted
  messages. Keep one current API; no parallel legacy runtime or permanent fallback clients.
- [ ] Update contract/client artifacts and architecture, run focused regressions and full owner
  gates, then complete the already authorized owner release path. Record exact version, commit,
  published artifact hashes and installed-runtime evidence; no consumer deployment is implied.

## Acceptance

- [ ] A real application-to-managed-provider input has correct non-CLI origin, reaches exactly
  one target turn and is retained in conversation/audit, with zero automatic Telegram echo.
- [x] Forged human/application claims, wrong application binding, stale target generation and
  unauthorized agent-to-human escalation are refused before append/provider submission.
- [x] Same messageId and identical content/context is idempotent; changed body, actor, channel,
  target or notification intent under that ID is a conflict. No repeated provider turn.
- [ ] Agent-to-agent traffic does not automatically notify a human. An authorized human-directed
  notice still reaches the enabled mirror; suppression of one row does not stall a later notice.
- [x] Feed reconnect/resume and sent/received copies preserve origin and stable identity and do
  not create duplicate notification eligibility. Historical records remain readable and quiet.
- [x] CLI and native managed messaging keep honest author/permission semantics. Absence of
  provenance evidence is explicit rather than a guessed human or agent identity.
- [x] Upload, pin, preview and message-operation ownership use the same durable machine authority
  across the principal cutover; accepted pending image input survives upgrade without widening scope.
- [x] Explicit human-facing external courier messages remain eligible; distinct message IDs with
  identical bodies remain distinct messages and notifications.
- [ ] Contract, daemon/client, tests and current architecture agree. Report deterministic tests
  separately from live provider/Telegram evidence and disclose crash/uncertain-send limits:
  transport without recipient idempotency must not be advertised as exactly-once delivery.

## Priority and boundaries

High-priority correctness/privacy defect: input is exposed through unintended notification
channels. Scope is owner admission, durable envelope/projection and Telegram mirror. Existing
sessions, accepted work, history and credentials must survive the change. No public examples or
task metadata may contain private consumer identities or operational addresses.

## Accepted minimal contract

Service and local-control ingress identify the authenticated machine authority separately from
CLI/managed authorship. Application attribution is optional and requires an exact host-owned
caller/application/channel binding; an attributed human is not a verified human identity. Preserve
existing durable authority keys for attachments, pins and operation receipts. Store accepted
origin, audience and registration generation in the canonical envelope and retry fingerprint.
Application input pins registration generation. Conversation input is quiet; owner-directed notices
require explicit intent and host authorization. Existing explicit owner/external courier routes
remain available. Historical absent provenance normalizes to unknown/quiet per bounded record;
do not rewrite history or reset cursors. Snapshot/feed expose the same structured message identity.

## Что сделано

- Added `src/chat/originSchema.ts` and `origin.ts`; service/local ingress identifies transport
  independently of actor. Host bindings attest categories, not a human identity. Binding revision
  and digest participate in retry consistency. Owner logs retain refusal reason without the body.
- Updated control admission, both typed clients, canonical ledger, snapshot/feed, native framing
  and Telegram audience admission. Existing attachment/operation machine keys are unchanged.
- `test/control-service.test.ts` verifies old uploads and accepted pending image pins through the
  ingress cutover, including preview and operation reads. `test/message-audience.test.ts` verifies
  quiet history/input/peer traffic, explicit owner/courier notices, distinct IDs, resume and uncertain
  sink retries. No global exactly-once guarantee is claimed.
- Source real-provider acceptance: one Codex image turn through declared service, application
  framing observed in native history, exact correlated turn, daemon restart/retry, retained preview,
  forged application and stale generation refusals. The isolated fixture archived its session and
  all three tracked processes exited. No production session/config was changed.
- Initial complete local gate: 1000 tests passed, with packed Bun/Node execution and both TypeScript
  module-resolution checks. The final gate also covers the explicit exported origin contract.
- Published-runtime, live Telegram and fleet verification remain open below the release boundary;
  deterministic mirror tests are not represented as delivery to a real sink.
