---
title: Bind managed collaboration mode to an immutable host recipe
description: Enable native input requests without caller-authored provider settings, prompt text or a second response protocol.
type: decision
status: active
created: 2026-08-29
updated: 2026-08-29
---

# Decision

A managed Codex launch recipe may declare a typed `collaborationMode`. The public create request
still contains only `{ id, revision }`; callers cannot send a mode, model, effort, developer
instructions or arbitrary native flags. The mode is part of the recipe's canonical digest and safe
metadata, so create idempotency, the durable session identity and restart verification all bind to
the same policy revision.

Recipe-less sessions and recipes without this field send no collaboration override. Their current
provider-default behavior is unchanged.

# Provider authority and turn admission

Before every managed turn it starts, CCMux calls the installed App Server's `collaborationMode/list`. It must
find the configured mode, and the loaded thread must report a model. CCMux uses the provider preset's
model and reasoning effort and sends `developer_instructions: null`, preserving the provider's own
built-in instructions. It does not copy, synthesize or persist prompt text.

This check covers the bootstrap turn and native message delivery, including deferred pickup after
daemon or provider restart. It completes before pickup intent is persisted or `turn/start` is sent.
An absent method, missing preset, malformed response or missing loaded-thread model returns the
generic `COLLABORATION_MODE_UNAVAILABLE`; exact cause stays in the owner log. No false pending input
request or indeterminate accepted turn is created.

An attached native TUI remains a separate human control surface. Turns submitted directly there
use its explicit interactive collaboration selector rather than the control policy. CCMux does not
race that selector with background `thread/settings/update` calls.

# One input protocol

Plan mode lets the provider emit its native `request_user_input` server request. The existing native
projection retains the provider request ID, turn ID, projection generation, kind and exact question
IDs. The existing response operation remains the only answer path and keeps its stale-generation,
wrong-kind, wrong-question and changed-idempotency refusals. Collaboration policy adds no transcript
parser, prompt injection, UI keystroke response or second writer.

# Projection boundary

Create receipts, status and native snapshots may expose the safe recipe identity, digest,
capabilities and mode name. Provider preset instructions, recipe definitions, environment values,
paths and credentials never cross the control boundary. Packed Bun and Node clients consume the
same additive schema field and unchanged service operation identities.
