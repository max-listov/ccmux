---
title: Preserve native tool identity and distinguish lifecycle completion from outcome
description: The current content stream drops native failure evidence and tool names, preventing truthful consumer tool status.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30
priority: P1
---

## Evidence

Published `0.39.31`, source `src/content/codex.ts` and `src/content/opencode.ts`.
Calling the installed Codex observer with `item/completed`, tool type `commandExecution`,
native `status: failed`, `exitCode: 1` produces the same lifecycle status `completed` as
a successful tool. The local Item schema strips native outcome fields before projection.

Calling the installed OpenCode observer with tool `bash`, `state.status: error` produces
`lifecycle('tool', turn, callId, 'error')`: the tool name is omitted, although the native part
contains it. The history adapter likewise exposes a tool entry without its name.

These are deterministic installed-source probes, not claims about a live failed shell run.
Consumers can currently show only lifecycle metadata and explicitly unknown results; they
must not infer tool success from `complete` or turn success, or reconstruct it from text.

## Required result

- [x] Define bounded typed public tool observation fields for name, lifecycle and known/unknown
  outcome. Preserve native failure/interruption when supplied. Completion alone is not success.
- [x] Supply the same semantics for both native runtimes and history/replay; preserve stable
  tool call identity across updates. Avoid raw provider dumps, secrets and private tool payloads.
- [x] Golden tests distinguish successful/nonzero-exit/failed/interrupted/unknown outcomes and
  preserve OpenCode tool names. Reconnect must retain the same evidence.
- [x] Verify real successful and failing tools through the installed public client, then publish
  the fix with exact release evidence and update the descriptor if the contract changes.

No consumer-specific adapter, prompt parsing or second writer. Missing evidence stays explicit.

## Implementation plan

One shared typed `tool` observation carries native call identity, bounded name, lifecycle,
outcome and an optional observed exit code. The content item identity remains the provider item
identity, including the OpenCode part ID; the separate call ID joins native tool updates without
conflating an item, an assistant message and a turn. Non-tool records have no tool observation.

Lifecycle is pending/running/completed/unknown; outcome is independently
unknown/succeeded/failed/interrupted/declined. A completed event without authoritative result
evidence remains unknown. Native status/exit/result metadata is interpreted by the provider adapter;
commands, arguments, output, raw error strings and arbitrary metadata are not projected.

- [x] Share provider outcome mapping between live observation and native history.
- [x] Preserve exact identities and terminal evidence through bounded baseline/replay and reconnect.
- [x] Cover success, nonzero exit, failure, interruption, decline, absent evidence and private payloads.
- [x] Run isolated successful/failing native shell turns through the typed public client on both
  runtimes, then verify the published artifact and owned installations.

## Что сделано

- `src/content/toolSchema.ts` defines one observation shape; provider mappers in
  `src/agent/{codex,opencode}/toolObservation.ts` serve live content and native history.
- `src/content/buffer.ts` retains typed terminal evidence through bounded replay and late updates.
  OpenCode part ID and call ID now keep their separate native meanings in both public paths.
- `test/tool-observation.test.ts` covers golden outcomes, private-payload omission, stable IDs,
  explicit unknowns and reconnect. Packed-client verification exercises the same exported schemas.
- `scripts/native-tool-observation-acceptance.ts` passed against source and an installed packed
  client plus built runtime outside the checkout. Both runtimes executed exactly two shell calls,
  exits 0 and 7, while the parent turn completed. Live/history/reconnect matched; daemon/provider
  restart retained exact tool identities/outcomes. Cleanup archived only two fixtures, with all five
  tracked fixture processes gone and zero archive failures. Telegram was disabled in isolated config.
- Architecture and decision documents describe outcome authority and unchanged bounded transport.
  Publication/post-rollout acceptance is recorded below.

## Published verification

`v0.39.32`, release SHA `cae03aff71dfdf3c845aa15b1f54692bbff9982b`, implementation
`d58f7a7db57bc811f22f1e38482bf569d459e69b`. Runtime SHA256
`f2389f99fc4eb1100c41f777918b560d8959a5150fd5ec2f4cb38b7983bb5f7e`; public client SHA256
`0069f56030641ded1d5b3b34237b06c98a84ea52843331c0f5804b362ddef896`.

Both exact-SHA CI runs passed; full local/release gate: 956 tests, 4785 assertions, 153 files,
zero failures, Biome, typecheck and five packed Bun/Node/type-consumer gates. Downloaded GitHub
runtime and installed tgz repeated both real exit-code tools, live/history/reconnect, daemon/provider
restart and exact cleanup proofs. All three owned runtimes have matching version/hash and live
projections; all 33 preexisting running identities/start times were preserved.

[Public verification artifact](https://github.com/max-listov/ccmux/releases/download/v0.39.32/post-rollout-verification.json)
contains allowlisted facts and evidence digests, not private runtime identifiers or payloads.
