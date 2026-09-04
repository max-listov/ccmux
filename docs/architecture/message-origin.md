---
title: Message origin and notification audience
description: Preserve authenticated ingress, attributed authorship and explicit notification intent independently of execution authority.
type: architecture
status: active
created: 2026-08-31
updated: 2026-08-31
---

# Authority and attribution

The durable envelope is authoritative. Its `from` is the authenticated principal, not a claim about
the human behind a request. CLI uses a CLI principal; local control and declared-service ingress use
a service principal with their transport. Managed credentials retain exact runtime/machine/session/
thread identity. A control socket authenticates the execution account; the trusted transport supplies
declared-service `caller` outside the operation payload.

Service and CLI share the existing opaque machine-authority key. Its persisted encoding does not
describe authorship. Upload ownership, pins, native message receipts and steering use this same key,
so changing ingress does not orphan accepted work. This is host-level authority, not isolation among
application processes within the same host account/socket or trusted transport identity.

Optional `message.send.origin` is `{applicationId, channelId, actor}`. Actor is `human`, `agent` or
`application`, without a person's name, ID or purported permission. The execution host authorizes it:

```json
{
  "messageApplications": {
    "sample-app": {
      "revision": "r1",
      "callers": ["host-a"],
      "channels": ["chat"],
      "actors": ["human", "agent"],
      "ownerNotifications": false
    }
  }
}
```

The binding permits that machine to attest the listed application/channel/author categories. It
does not independently authenticate an application process or human. Accepted origin therefore says
`assurance: application-attested`; absent attribution says `actor: unknown`. Wrong caller, app,
channel, actor or ungranted owner notice refuses before ledger/pin/provider mutation. There is no
caller-supplied `from`, human credential, execution grant, product membership or new identity registry.
Host config changes require the normal daemon restart. Origin pins binding revision and digest;
changing a binding cannot silently reattribute accepted work.

# Admission and durable identity

```ts
await client['message.send']({
  target: created.target,
  registrationGeneration: created.registrationGeneration,
  messageId: crypto.randomUUID(),
  body: 'Please examine the attached image.',
  images: [image],
  origin: { applicationId: 'sample-app', channelId: 'chat', actor: 'human' },
  notification: 'conversation',
});
```

Attributed input requires registration generation. The envelope and receipt carry origin, audience
and generation alongside message/target identity. Retry checks principal, target, content, ordered
images, options, attribution and audience. Changed requests conflict; two IDs with equal text remain
different messages. Native framing identifies application-attested input, not a CLI invocation or
peer request. Unknown historical input is explicitly unknown. None of these fields grants permissions.
The state sequence remains validation → durable acceptance → native admission → terminal evidence.
Accepted input/images survive daemon replacement, retaining exact registration and digest checks.

# Audience and projections

`notification: conversation` is the default, including human input and peer coordination. Explicit
`owner` intent requires host permission in service requests (`ownerNotifications: true`). Existing
`msg owner` and configured external courier routes also produce explicit owner notices.

The Telegram mirror consumes rows in order. Suppression advances the cursor without a send or a
delivered claim; later eligible notices proceed. First activation starts at the present. Transient
failures hold the cursor; permanent failures skip the notice. Delivery/suppression logs identify the
message without its body. A lost Telegram response or crash before cursor persistence can duplicate
a notice: this sink is **not exactly-once**, because Telegram lacks recipient idempotency.

Snapshot/feed preserve `messageId`, structured `sender`/`target`, `origin`, `notification` and
`registrationGeneration`. Labels are display-only; `kind: chat` means received, not human-directed.
Sent/received copies retain the same identity; consumers correlate by ID, not text or timestamps.
The owner mirror reads only its destination ledger, never outbound copies.

The published `@ccmux/control-service-client` package root (repository entrypoint
`ccmux/control-service-client`) exports `LogRowSchema`, `LogPayloadSchema`, `LogFrameSchema`,
`LogMachineSchema`, `ChatPrincipalSchema`, `ChatTargetSchema` and inferred types. These are the same
definitions used by the runtime, extracted into `chat/feedSchema.ts` and `chat/identitySchema.ts`.
Their dependency graph is browser-safe and has no filesystem, process, CLI or runtime startup.
Use these schemas rather than copying consumer DTOs. Registration generation comes from a create
receipt or the public native snapshot/frame; `session.get` does not carry that field.

# Existing records

Absent persisted origin/audience is historical missing evidence. The reader projects fixed-size
unknown/quiet metadata per record without extra transcript scans, native calls or writeback.
Original bytes, order, IDs, accepted fingerprints, attachment/pin owners, operation keys and cursors
remain intact. Old pending input still delivers but gains no retrospective authorship or notification
eligibility. Current constructors write origin/audience. This is a storage-reading boundary, not a
second API/client. Malformed/unknown records retain their positions; history is not deleted or replayed.

# Verification

`test/message-audience.test.ts` covers suppression, failures, cursor resume, courier routes and
read-only history. Control-service tests verify bindings, registration and image ownership through
real local IPC with deterministic provider fixtures. These are not live provider/Telegram evidence.
`scripts/message-origin-acceptance.ts` runs an isolated real Codex image turn through service ingress,
restart/retry and exact native history. Explicit `--telegram` uses the existing sink for one labelled
owner notice after proving input suppression; production config and sessions are not changed.
