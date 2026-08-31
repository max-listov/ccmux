---
title: Preserve message origin and explicit notification audience
description: Separate authenticated ingress, attributed author and human notification intent across admission, durable chat records and their projections.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 13:35 +0700
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
- [x] Update contract/client artifacts and architecture, run focused regressions and full owner
  gates, then complete the already authorized owner release path. Record exact version, commit,
  published artifact hashes and installed-runtime evidence; no consumer deployment is implied.

## Acceptance

- [x] A real application-to-managed-provider input has correct non-CLI origin, reaches exactly
  one target turn and is retained in conversation/audit, with zero automatic Telegram echo.
- [x] Forged human/application claims, wrong application binding, stale target generation and
  unauthorized agent-to-human escalation are refused before append/provider submission.
- [x] Same messageId and identical content/context is idempotent; changed body, actor, channel,
  target or notification intent under that ID is a conflict. No repeated provider turn.
- [x] Agent-to-agent traffic does not automatically notify a human. An authorized human-directed
  notice still reaches the enabled mirror; suppression of one row does not stall a later notice.
- [x] Feed reconnect/resume and sent/received copies preserve origin and stable identity and do
  not create duplicate notification eligibility. Historical records remain readable and quiet.
- [x] CLI and native managed messaging keep honest author/permission semantics. Absence of
  provenance evidence is explicit rather than a guessed human or agent identity.
- [x] Upload, pin, preview and message-operation ownership use the same durable machine authority
  across the principal cutover; accepted pending image input survives upgrade without widening scope.
- [x] Explicit human-facing external courier messages remain eligible; distinct message IDs with
  identical bodies remain distinct messages and notifications.
- [x] Public browser-safe client exports snapshot/feed and endpoint schemas from their single
  canonical definitions; packed consumers import them without copying DTOs or loading runtime I/O.
- [x] Contract, daemon/client, tests and current architecture agree. Report deterministic tests
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
- Published-runtime and live Telegram qualification completed below. Full release closure remains
  open for the reproduced managed HTTP-stream shutdown dependency defect; notification assertions
  are not evidence of clean daemon shutdown under an active resident stream.
- Candidate 0.39.35 tag CI stopped publication: the pre-existing capacity fixture performed 256
  whole-journal write transactions and exceeded its 5-second test deadline (5.7 seconds setup;
  the refusal itself took 4 ms). Replaced repeated setup with one schema-checked full journal,
  preserving the deadline and adding unchanged-journal evidence. The failed tag remains immutable;
  the next patch carries this qualification fix and the complete origin/audience implementation.
- The following local candidate was paused before push after a consumer identified missing public
  feed-schema exports. Extracted endpoint and feed schemas into pure modules and exposed them through
  the existing typed client entrypoint; added packed browser-build and shared-definition checks.
- Updated gate: 1001 tests / 5139 assertions, packed browser bundle, Bun/Node execution and both
  TypeScript resolutions passed. The live notification probe uses the actual explicit owner CLI
  route, without attributing a test-driver notice to the managed provider.

## Initial publication and reproduced lifecycle blocker

- Published `v0.39.37`, release SHA `77eb8dfe07391ebd3196b9ebad2d03664423660a`;
  origin implementation `7452e20700edf4dd0be4d41757f605dde41d99e8`, final public-schema
  implementation `c8a1fb4188f1c7e2d7569fb6bb825ebc3fb60ed1`.
- Exact-SHA tag CI `33359986696` and main CI `33359986451` succeeded. Full local gate:
  1001 tests / 5139 assertions; packed browser, Bun, Node, NodeNext and Bundler checks passed.
- Downloaded published bundle SHA-256:
  `aa7ac2f01662400cad6911f0e9a64a07ca75aa4cd7d7a0a10edd77804e7d411e`.
  Downloaded typed-client archive SHA-256:
  `e309266fc41e79b1e44ee3004d8db5ac6c97c3e3af78fab42b779920675dc194`.
  Both match published checksums; the downloaded archive passes all packed consumer checks.
- `scripts/message-origin-acceptance.ts <published-bundle> --telegram` exited zero: actual Codex
  image consumed, honest application framing in native history, one exact turn, accepted retry
  across daemon replacement, retained preview and zero input echo with the real sink enabled.
  One explicit owner notice was delivered. Peer suppression and uncertain-send behavior are
  deterministic tests, not a claim of exactly-once Telegram delivery. The fixture archived its
  one session; all three tracked processes exited and both fixture shutdowns reported clean.
- All three owned runtimes have the exact published bundle and live daemon version. The 35
  previously running sessions remain running with the same UUIDs and non-reset uptime; no live
  lifecycle errors. Doctor exits zero on all three. Host configuration was not changed.
- The rollout also exposed a separate release blocker: a real daemon with an active resident HTTP
  stream reports control-resource force cleanup failure after its 5000/2000 ms shutdown budgets.
  A second restart of the newly installed `0.39.37` reproduces it. Healthy startup and preserved
  sessions do not turn that shutdown report into successful release qualification.
- Independently reproduced through published `stitchkit@0.70.2` and latest `0.70.4` with a real
  Unix-socket NDJSON contract, `managedServerResource`, and a cooperative signal-aware source:
  positive HTTP 200 frame, then `cleanupComplete: false`, source not aborted/returned, one pending
  response. Finite-source control is clean in about 3 ms. The same raw Bun stop behavior reproduces
  on Linux and macOS. No copied server lifecycle or consumer runtime workaround was added.
- Owner follow-up completed in Stitchkit
  `docs/backlog/done/2026-08-31-managed-server-shutdown-with-active-http-streams.md`.
  The fixed artifact is adopted and qualified in the next patch below. The initial failed
  shutdown evidence remains valid for the earlier artifact, not the corrected release.
- The release asset `post-rollout-verification.json` records passing feature evidence and the
  unresolved lifecycle qualification separately. It explicitly declares blocked closure, rather
  than presenting live status, preserved sessions or successful CI as a clean shutdown proof.

## Dependency qualification follow-through

Stitchkit 0.70.5 is published at `54879c4a3e080a6b9edfdb295d4440fe4969b63d`;
exact-SHA CI `33363360555` and publication `33363630991` succeeded. It owns cancellation and
draining of cooperative HTTP sources; no consumer lifecycle wrapper is required.

- [x] Reproduce an open native control stream through the existing managed application boundary
  on the old dependency, then pin 0.70.5 and prove clean shutdown without cancelling the client first.
- [x] Run the complete local and packed-client gate; qualify a real managed session with an open
  resident stream across daemon replacement, retaining identity and accepted-message correlation.
- [x] Publish the next patch from the canonical checkout, verify exact-SHA CI and artifacts,
  then verify all owned runtimes and their clean shutdown self-report before closing this task.

- `test/control-service.test.ts`: positive native frame and exact registration precede shutdown;
  0.70.2 returns incomplete cleanup at the same 100/200 ms budgets, 0.70.5 is clean with no
  pending requests or client-side abort. The registry is unchanged. Independent finite/open
  source controls also pass; open-source cancellation and finally settle in about 9 ms.
- `scripts/message-origin-acceptance.ts` now keeps a native subscription open while replacing
  its real managed daemon. Source acceptance passes: clean shutdown in about 14 ms, ordinary
  signal exit 143, explicit stream interruption and reconnect at the same generation/cursor.
  The exact accepted image message completes once; retained preview and refusal cases pass.
  The isolated session is archived and all three tracked processes exit. No notification was
  sent by this source run; the previous published real-sink evidence remains separate.
- Updated complete gate: 1002 tests / 5149 assertions, plus packed browser, Bun, Node,
  NodeNext and Bundler consumers. The release ceremony repeats the full gate on the final tree.

## Terminal qualification: 0.39.38

- Release/tag `72f01b544fff58187041eb40ae7adc7a6d4d37ea`; lifecycle implementation
  `0feb9c7a96092e5b63f486a131641bc60a96a313`. Canonical checkout HEAD, remote main, tag and
  package version agree. Exact-SHA tag CI `33364380179` and main CI `33364380091` succeeded;
  tag CI passed 1002 tests / 5147 assertions on its platform plus all packed-client gates.
- Downloaded bundle SHA-256 `302bcf501c8e187d41a4ffe5e3a84ef62fc760bb5dda317acc58907ed179dbf9`;
  typed-client archive SHA-256 `502caca1bc5687830a4aec8a9c16ff9626571e1b72fb47adfd1556854d3c9a27`;
  native client SHA-256 `b234efe3c6b60a9938cb0934b124bcaeca4f47622915b81199c705a035fad01e`.
  Published checksums match; downloaded client passes browser, Bun, Node and both type resolutions.
- Published-bundle real Codex acceptance passed with an open native reader: clean shutdown in
  about 11 ms, explicit stream interruption, same-generation cursor resume, exact image turn,
  retained preview and idempotent accepted retry. The actual notification sink suppresses input
  and delivers one explicit owner notice. Cleanup archives the fixture and stops all three
  tracked processes; no supervised production provider is restarted by this probe.
- All three owned installations and live daemons run the exact published bundle. The 35 previously
  running sessions preserve their UUIDs and uptime, with no live lifecycle errors. Doctor exits zero
  on each host. Each installed daemon is then gracefully restarted while readers remain subscribed:
  two hosts have real managed/native readers, the third has a managed snapshot reader (no native
  session was invented there). Clean shutdown durations are approximately 12, 27 and 21 ms.
  All resources report closed, cleanup complete; clients did not cancel first. Boot units restore
  the same installed version. The checked daemon generations have no warning/error log records.
- The corrected release's `post-rollout-verification.json` records this complete qualification;
  the previous release's explicitly blocked artifact is unchanged. No consumer configuration,
  credentials, provider policy or host reboot is part of the rollout. This task is complete;
  independent image/authentication and historical privacy tasks retain their own open scope.
