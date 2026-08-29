---
title: Managed Codex collaboration mode for input requests
description: Let a trusted managed-session policy enable native request_user_input without caller-authored flags or prompts.
type: task
status: done
created: 2026-08-29
updated: 2026-08-29
completed: 2026-08-29 15:58 +0700
priority: P1
related:
  - docs/architecture/control-plane.md
  - docs/architecture/launch-recipe.md
  - docs/decisions/2026-08-29-managed-codex-collaboration-policy.md
  - docs/backlog/in-progress/2026-08-29-server-owned-launch-recipes-for-managed-control-sessions.md
---

## Why

The managed native projection and response contract already support exact input requests and
answers. A real managed Codex turn can nevertheless expose the `request_user_input` tool while
running in Default collaboration mode. Calling it then completes as a tool error with
`request_user_input is unavailable in Default mode`; no pending request is emitted, so a control
client has nothing it can answer.

This leaves a supported response surface that cannot be exercised by an ordinary managed turn.
Retrying the tool, parsing transcript text or injecting instructions at the consumer would not
change the provider mode and would create a false approval/input path.

## Requested result

- [x] Add a typed owner-defined collaboration-mode policy to the managed Codex launch/turn path.
  The caller may select only an allowlisted immutable policy or recipe capability; it cannot send
  arbitrary flags, prompt text or provider configuration.
- [x] Apply the selected mode to every CCMux-started provider turn in the managed session, including message
  delivery after daemon/provider restart and deferred pickup.
- [x] Bind mode identity/revision to create idempotency and expose safe applied capability metadata
  in create/session receipts without exposing private config or prompt contents.
- [x] Fail closed before accepting a turn when the selected installed provider does not support the
  requested collaboration mode.
- [x] Preserve the existing exact generation/request/kind response contract and stale-response
  refusal; do not add a second input protocol.
- [x] Keep recipe-less/default managed creation backward compatible.
- [x] Add packed Bun/Node client coverage and update public service descriptors and architecture.

## Acceptance

- [x] A real managed Codex turn calls native `request_user_input` and produces one pending input
  request instead of the Default-mode tool error.
- [x] The exact answer resumes the same turn and reaches terminal success.
- [x] Wrong generation, request ID, kind, question IDs and duplicate changed payload refuse.
- [x] Daemon/provider restart preserves the selected collaboration mode and same native identity.
- [x] Default-policy sessions retain current behavior and receive no implicit mode change.
- [x] Full gate, exact-SHA CI, patch release and owned-runtime rollout are green.

## Evidence

In a real managed App Server session, the model emitted a native `request_user_input` function call
with a valid one-question schema. The provider recorded the completed tool result
`request_user_input is unavailable in Default mode`, emitted no pending request and then completed
the turn. This proves the missing boundary is provider collaboration-mode selection, not response
serialization or pending-request projection.

## Что сделано

- The public request remains a recipe id/revision only. The host recipe's typed mode is included in
  its immutable digest and safe metadata; no caller model, effort, instructions or mode field is
  accepted.
- Before bootstrap and delivered turns, CCMux verifies `collaborationMode/list` and uses the
  installed preset with the loaded thread model. Unsupported/malformed capability state refuses
  before pickup persistence or `turn/start`; recipe-less turns send no override.
- Focused coverage passed 27 tests, including one-writer recipe idempotency, bootstrap retry,
  unsupported-provider refusal, default-path preservation and packed Bun/Node clients.
- `bun run check` passed 791 tests with 0 failures and all packed install, Bun runtime, Node
  runtime, NodeNext and bundler type gates.
- A real isolated managed session produced and answered native input twice. Wrong generation,
  request, kind, question IDs and changed idempotency payloads refused. Provider and daemon restart
  retained one thread identity, recipe digest and Plan policy before the second round-trip.
- Exact-SHA CI run `33244165089` passed on implementation commit
  `61a4c531c6f003a651d1af06fc10251cea5b4c06`. Release/tag `v0.39.21` points to
  `5f2b5c1c1713b77409cf648699b20eaa7ac9dc05`; tag CI run `33244283954` published the release.
  Every owned runtime reports `0.39.21` and the exact released bundle SHA-256
  `788c24cbe39555e2798c290aa08a5460dda5f9540fc568f839f69db704f08fce`.
