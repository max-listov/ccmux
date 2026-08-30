---
title: Preserve native approval scope and cancellation while awaiting approval
description: Expose bounded permission context and allow exact cancellation of a suspended native turn without accepting its request.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30
---

## Problem

Public 0.39.31 OpenCode permission projection reports `reason: external_directory`, request/turn
identity and accept/acceptForSession/decline decisions, but no requested path/pattern. A consumer
cannot present informed approval or safely distinguish a canonical instruction read from broader
filesystem access. `src/agent/opencode/protocol.ts` drops native scope fields before projection.

In a real managed read-only skill task, the public pending request remained visible with a matching
inProgress turn. Calling `turn.interrupt` with that exact correlated turn returned 409 TURN_MISMATCH,
"The exact working turn is unavailable". `src/runtime/interrupt.ts` requires state `working`;
permission suspension is not working but must remain cancellable. Public archive stopped the probe;
archiving the whole conversation is not a replacement for cancelling one pending turn.

## Result

- Bounded, typed, display-safe permission resource/operation context from native evidence. Missing
  context is explicit; never infer it from assistant text, tool names or caller intent.
- Exact cancellation works in waiting-for-approval/input as well as active computation, retaining
  generation and turn checks, without accepting permission or performing the suspended side effect.
- Unknown or stale requests remain refused; no blanket permissions or new native writer.

## Acceptance

- [x] Reproduce native external-directory request with distinct narrow/broad paths and verify the
  public request preserves the information needed for informed approval without secret bodies.
- [x] Interrupt a real suspended request; verify terminal interruption, pending request removal,
  no tool side effect, unchanged session identity, and a subsequent usable turn.
- [x] Cover stale turn/generation, repeated interrupt and concurrent native settlement.
- [x] Publish the current client/runtime contract and return exact release plus real receipts.

## Implementation plan

Native request projection is the authority. Add bounded resource-pattern context, keeping immediate
request scope separate from the scope of a session-wide grant. Missing/omitted context is explicit;
raw tool input, shell text and metadata do not become public approval context.

Cancellation binds the caller's native generation and exact in-progress turn. Working,
waiting-approval and waiting-input are cancellable; idle/unknown/stale evidence is refused. Native
abort does not answer or accept a request. Terminal native evidence retires pending requests for
that exact turn, including when the provider emits no separate permission-resolved event.

## Что сделано

- `src/runtime/permissionScope.ts` declares bounded filesystem pattern context with separate
  requested/session grant scopes and explicit omissions. OpenCode projection uses only native
  allowlisted fields; unsupported contexts stay null and private payloads are not published.
- `ControlInterruptSchema` requires generation. Both provider cancellation paths validate exact
  active/suspended turn identity. The existing OpenCode owner rechecks after persisting intent;
  unknown ACKs stay uncertain, repeated accepted cancellation does not abort a new turn.
- `src/agent/opencode/projection.ts` retires the exact terminal turn's pending requests even when
  the native cancellation finalizer emits no reply event; late requests cannot reopen that turn.
- Seven golden tests cover scope bounds/privacy, stale identities, both settlement windows,
  duplicate cancellation and lost ACK. The public client package exercises the changed typed input.
- Source public-client E2E cancelled two real OpenCode external-directory write requests with
  distinct scopes. Both files stayed unchanged; pending requests disappeared and another turn
  completed on the same identity. A real Codex input request was cancelled and recovered likewise.
  No approval was accepted. The isolated fixtures were archived and all five processes exited.
- Published artifact acceptance passed as recorded below.

## Published verification

`v0.39.32`, release SHA `cae03aff71dfdf3c845aa15b1f54692bbff9982b`, implementation
`d58f7a7db57bc811f22f1e38482bf569d459e69b`. Runtime SHA256
`f2389f99fc4eb1100c41f777918b560d8959a5150fd5ec2f4cb38b7983bb5f7e`; client SHA256
`0069f56030641ded1d5b3b34237b06c98a84ea52843331c0f5804b362ddef896`.

Downloaded GitHub runtime and installed public client passed narrow/broad external-write
cancellation without either write, exact stale identity refusals, repeated abort safety, real native
input cancellation and subsequent turns on unchanged identities. Both fixtures were archived and
all five tracked processes exited. Three owned runtimes have exact hash/version parity and live
projections; 33 preexisting running sessions kept identity and start times.

One qualification attempt ended without invoking a tool because the model refused an unqualified
cross-project instruction. The fixture now declares the host owner's narrow mandate for its two
disposable files, without granting native permission. It fails immediately on a terminal turn with
no request instead of waiting for a nonexistent approval. The corrected probe passed against the
published artifact; this fixture correction ships with the completion evidence.

Full gates: 956 tests, 4785 assertions, 153 files, no failures; Biome, typecheck, all five packed
consumer gates and exact-SHA CI passed. [Public verification](https://github.com/max-listov/ccmux/releases/download/v0.39.32/post-rollout-verification.json)
records safe receipts and evidence digests.
