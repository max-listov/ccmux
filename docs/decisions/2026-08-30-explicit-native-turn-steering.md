# Explicit identity-pinned native turn steering

Status: accepted implementation decision. Native release acceptance is recorded in the task.

## Decision

Steering is separate from ordinary durable messaging. The request supplies an operation UUID,
exact managed target and registration, native runtime generation, expected active turn ID, text
and ordered immutable image references. It cannot select a model, mode, permissions, executable,
path or provider configuration. Ordinary queued/deferred messages still wait for an idle boundary.

Codex maps the request to structured `turn/steer` with `expectedTurnId` and
`clientUserMessageId = steer:<operationId>`. The namespace prevents an ordinary UUID message on the
same turn from falsely proving steering acceptance. The installed generated protocol declares both fields. The
[official App Server contract](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)
states that a mismatched or absent active turn refuses and no new turn-start event is emitted.
No terminal injection or replacement turn is permitted. The existing interactive-client guard
only protects unsent human input and menus; native state is the sole working/idle authority.

OpenCode currently has no verified atomic expected-turn precondition in its native prompt
operation. Its steering operation therefore returns `UNSUPPORTED`; sharing text/image types does
not imply identical native guarantees. No CLI bridge, silent new turn or optimistic status check
substitutes for the missing native precondition.

## State and serialization

`observed active → durable intent → submitted | uncertain → positively reconciled submitted`.

The shared native admission lock serializes message pickup, selection, context changes and
steering. The registration lock protects exact target checks, image pins and intent creation.
Projection and direct native status must agree on active work; pending input/approval and unresolved
context mutation refuse. The projection generation and turn are checked again immediately before
persisting intent. Codex's expected-turn precondition closes the remaining completion race.

Pins are durable before intent. Verified bytes are resolved privately before submission; no
private path or image body enters public receipts. Image steering additionally requires the
active turn's accepted pickup/ledger model selection and verified image modality. Future session
defaults cannot prove the model of an already-running or interactive turn; unknown evidence refuses
image steering instead of stripping images. Text steering does not need that modality evidence.

The private journal is bound to the managed registration and native thread. It stores an immutable
request fingerprint and caller identity, not the message body. It uses no-follow private files,
file fsync, atomic rename and directory fsync. Capacity is 256 operations and 256 KiB; exhaustion
refuses new operations rather than forgetting idempotency. The operation request is at most 32 KiB
including at most 24 KiB UTF-8 text and the shared four-image reference bound.

## Retry and outcome

`submitted` confirms native input acceptance on the original turn, not completion or success of
that turn. `uncertain` explicitly does not confirm acceptance. Transport loss, malformed replies,
unexpected returned turn IDs and currently unstructured native RPC errors remain uncertain. Even
a native precondition rejection whose typed error was lost is not falsely reported as accepted.

An exact retry returns the retained result; changed payload or caller refuses. Intent found after
restart is never sent again. A bounded native history lookup may promote uncertainty only when a
user message's exact client ID appears on the original turn. No match, disconnected runtime or a
matching client ID on another turn leaves uncertainty; it does not authorize another injection.
Receipt reads may reconcile after provider restart or turn completion while preserving the original
generation and turn. Archive preserves receipts and pins; registration replacement cannot reuse them.

## Validation

Focused tests cover concurrent retries, changed callers/payloads, registration and generation races,
native completion race, lost acknowledgements and crash intent, positive/negative reconciliation,
approval/input waits, human draft guards, context barriers, unsupported adapter admission, private
journal corruption/symlinks, cancellation and ordered image pinning. Real inference and publication
are distinct acceptance gates; unit fixtures do not claim those results.
