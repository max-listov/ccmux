---
title: Explicit identity-pinned native turn steering
description: Add deliberate active-turn input while preserving idle-only durable messaging and exact approval boundaries.
type: task
status: done
completed: 2026-08-30 13:02 +07:00
created: 2026-08-30
updated: 2026-08-30
priority: P2
pipeline: native-harness-control
order: 4
depends-on:
  - 2026-08-30-managed-image-attachments.md
  - 2026-08-30-in-session-model-and-mode-selection.md
---

## Why

The current durable message/defer behavior intentionally waits for idle. Interrupt exists, but no
public operation supplies new input to the exact active native turn. Changing ordinary `message`
to imply steering would violate existing inter-agent delivery guarantees.

[Codex App Server](https://learn.chatgpt.com/docs/app-server) exposes `turn/steer` with an exact
expected turn ID and no model/policy overrides. the reference harness's
OpenCode adapter
maps active-session input through native prompt admission. That mapping is evidence to investigate,
not proof that OpenCode offers the same atomic precondition or turn semantics as Codex.

## Result and state

An explicit typed steer operation carries managed/native identity, expected current turn/generation,
operation ID and the shared text/image input type. Its receipt separates native acceptance from
completion. Existing message/defer, interrupt and approval/input-response operations keep their
meanings. A normal chat message never interrupts or steers implicitly.

State: `observed active → intent → accepted/uncertain → reconciled`; idle, changed turn, disconnected
or pending approval/input refuses. A lost reply never becomes a blind second injection. Native
steering does not grant permission to change model, launch policy or answer a pending request.

## Plan

- [x] Add granular steering capability with native guarantees and limits. Verify installed protocols
  and test the race where the turn completes between preflight and submission. If an adapter cannot
  enforce the promised condition, expose that operation as unsupported rather than fake exactness.
- [x] Add a separate operation to the existing contract/descriptor/client. Reuse attachment validation,
  selection restrictions, durable operation identity and admission reconciliation; no second queue.
- [x] Implement Codex native steering; map OpenCode only with verified native admission and causal
  behavior. Never synthesize mid-turn input with terminal typing or silently create a fresh turn.
- [x] Correlate steering receipts and events with the original active turn; distinguish native input
  identity where the provider creates a separate message. Preserve the original terminal outcome.
- [x] Document rejection/retry behavior and queue-versus-steer examples. Unsupported image steering
  refuses; it must not silently strip the attachment or downgrade into an ordinary queued message.

## Acceptance

- [x] A real supported runtime incorporates an explicit correction during a deliberately long turn.
  Native evidence proves the intended turn received it and no replacement writer appeared.
- [x] The default message path still waits for idle, including a deferred image message. Only explicit
  steer changes active work; an ordinary retry does not acquire steering semantics.
- [x] Turn-completion race, stale generation/turn, duplicate ID, changed input, approval/input waits,
  interrupted transport and restart produce correct refusal/reconciliation without duplicate injection.
- [x] Test both adapters against their actual protocols. Record unsupported exact-turn guarantees
  as a concrete capability limitation and evidence, not a passed interoperability claim.
- [x] Packed Bun/Node client checks, full local gates and exact-SHA CI pass. Record the release and
  artifact hashes and owned-runtime rollout proof; leave unverified support explicitly unresolved.

## Boundaries

No implicit steering, generic config mutation, automatic interruption or terminal scraping. This
is an explicit opt-in extension in the [native control roadmap](2026-08-30-native-harness-control-parity.md),
not a change to the established idle-only inter-agent chat contract.

## Что сделано

- [x] `src/steering/` provides exact native CAS, durable intent and correlated uncertain/retry
  semantics; `test/steering-*.test.ts` covers admission and recovery boundaries.
- [x] `scripts/native-image-steering-acceptance.ts` proves native correction of the same Codex turn,
  duplicate receipt, stale generation refusal, pending input refusal/exact answer and deferred image.
- [x] OpenCode explicitly refuses exact-turn steering before dispatch because its protocol does not
  provide equivalent CAS. This is a documented capability boundary, not fabricated parity.
- [x] Published `v0.39.25`: implementation `3c7235454e657cefa5ec570d6fb4c927293b07e4`,
  release `2cc132e3e1bb1235d5dba967d7ba39655b8a58b1`; exact-SHA CI run
  [33295298409](https://github.com/max-listov/ccmux/actions/runs/33295298409) passed.
  Runtime bundle SHA-256: `3de1dc4e00afae0f7af1030068aa8d9e67a9ac8d2bfcd20374fdc2687b83e0ff`.
  Downloaded client archive SHA-256: `4ab1717877b4c154eaae3a84810656628d8043ce978266c7299ab42b4b0df72d`.
  The actual published archive passed installation, Bun/Node and both TypeScript resolution checks.
  All three owned runtimes reported this exact version/hash and live owner projections; existing
  managed identities and running sessions were preserved. Local native service revision 2 reads
  passed on both remote execution hosts; cross-machine transport activation remains a separate
  unresolved acceptance boundary in the roadmap.
