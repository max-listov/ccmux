# Communication authorization evidence

`message.send`, `ccmux msg` session targets, session-directed `ccmux relay`, and remote
chat reception require a structured explanation before accepting a new message. The
same requirement applies to local, fleet-prefixed, role and exact App addresses.
Transport availability, a peer's request, a reply address and `onBehalfOf` are not user
permission. Do not use another input tool to evade a refused message.

The canonical `CommunicationAuthorizationSchema` is exported by the control service
client. Its required fields are:

| Field | Meaning | Bound |
| --- | --- | --- |
| `whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope` | Why this recipient is necessary, the intended result and the current user-authorized scope | Trimmed, 40–4000 characters |
| `userAuthorizationQuote` | Verbatim user instruction permitting this communication | 1–4000 characters, not whitespace-only, preserved without trimming |
| `sourceMessageRef` | Reference identifying the source user message | Trimmed, 1–1000 characters |

Unknown object fields are rejected. No value is synthesized from the message body, a
task title, tool availability or an agent's claim that the user asked.

## Admission and storage

The control input always contains `communicationAuthorization`. `null` is admitted only
for a service caller whose human application channel passes the host's configured
`messageApplications` bindings. CLI and managed callers cannot self-label as human.
The raw remote envelope receiver does not admit that exception.

CLI callers provide `--communication-authorization <JSON file>`. The reader accepts a
regular file, reads at most 64 KiB, and does not put the quote in process arguments or
error output. Caller-owned files containing private quotes should have restricted access.
Owner notifications and cancellation do not require this peer-communication explanation.

Accepted evidence lives with the exact sender, target, timestamp and message ID in the
append-only chat ledger and outbound envelope. It is included in JSON log/feed rows,
not appended to the recipient's message text or notification body. It participates in
idempotency: retrying an ID with different evidence is a conflict. Historical records
without evidence remain readable, unchanged; absence means no evidence was recorded,
not that permission was granted. A bounded feed may omit an oversized claim with an
explicit note; the source ledger retains the complete quote under the same message ID.

## Trust boundary

This object is an **unverified caller claim**, not a credential or a verified grant.
CCMux checks shape and admission, not the semantic truth of the explanation. The layer
owning the source conversation must check the real author, exact quote, recipient and
action scope, and any subsequent restriction. A matching substring alone is not consent.
An unavailable source must remain unknown, never become approved.

This contract governs CCMux message admission. It does not intercept other products'
native task/chat tools, raw terminal keystrokes, or runtime control operations. Their
owners must enforce their own admission policy; this is not a sandbox for a malicious
agent with general shell access.

Live acceptance scripts sending messages require the same authorization file. Isolated
unit tests use synthetic fixture evidence only and do not contact real sessions.
