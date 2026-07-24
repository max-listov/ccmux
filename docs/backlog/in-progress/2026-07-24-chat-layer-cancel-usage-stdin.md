---
title: chat-layer follow-ups — cancellable watchdogs, honest usage, stdin
description: Fixes found in acceptance testing of the inter-agent chat / router layer (0.1.16) — msg cancel + task dedup, single-source usage, --after+--defer trap warning, stdin body, plus small doc/diagnostics
type: task
status: in-progress
created: 2026-07-24
updated: 2026-07-24
related: docs/backlog/done/2026-07-24-router-session-queue-until-idle.md
---

# chat-layer follow-ups (0.1.17)

Acceptance testing of the 0.1.16 inter-agent chat + router layer (a router↔worker pair, 24 scenarios)
surfaced a set of rough edges. This closes them. Nothing here changes the wire model — the message
schema is unchanged; cancellation reuses the existing append-only ack-log.

## Findings → plan

1. **No cancel / no task dedup.** Two identical `--after` watchdogs with the same `--task` both fire —
   idempotency was entirely on the router. Add `ccmux msg cancel <task>` (tombstone the sender's
   undelivered conditional mail for that task) and auto-replace a re-armed conditional sharing
   `(from, to, task)`.
2. **`msg --help` lagged the code.** Short help showed only `[--task X]`; the arg-error usage showed
   the full set. Two strings, one binary → unify to one source.
3. **`--after` + `--defer` is a trap.** The flags multiply to "not before T AND only at a turn
   boundary"; a self-watchdog armed that way doesn't arrive on time in a long turn (measured ~8 min
   vs the intended 90 s). A watchdog wants bare `--after`. Warn on send.
4. **No stdin.** `echo … | ccmux msg <to>` was rejected. Read the body from a pipe.
5. **`inbox` is a fallback, not a mailbox** — pane-delivered mail doesn't sit there. Document it.
6. **`hasAttachedClient` silently holds delivery** while a human is attached. Correct by design, but
   looked like a broken chat. Add a diagnostic log.
7. **Pane showed "Stop hook error:" vs transcript "Stop hook feedback:".** Investigated — the hook
   always exits 0 and writes valid JSON to stdout only. The "error" string is Claude Code's own pane
   render, not ccmux's wrapper. Rejected (external); no code change.

## Design notes

- **Cancellation = a tombstone in the ack-log**, `by: "cancel"`. The daemon and the Stop hook already
  skip any message id in that log, so one write suppresses both delivery channels — no new
  coordination surface, no ledger rewrite (the ledger stays the immutable source of truth).
- **Dedup key is `(from, to, task)` for conditional mail only.** Immediate mail is delivered at once,
  so there's nothing to replace. `--task` is thereby the explicit dedup key.
- **Cancel is scoped to the sender** — a session can only cancel its own dispatches.
- **stdin only when `!process.stdin.isTTY`** — an interactive shell with a missing body still gets the
  usage error instead of hanging on the terminal.

## Что сделано

- [x] `ccmux msg cancel <task>` — `src/commands/msg.ts` subcommand; tombstones via
  `appendAck(…, "cancel", …)`. Uses `pendingConditional()` scoped to `from`.
- [x] Task dedup / replace on re-arm — `src/commands/msg.ts` before append: tombstone priors sharing
  `(from, to, task)` for conditional mail.
- [x] `pendingConditional(ledger, acked, filter)` + widened `appendAck` `by` union — `src/chat/store.ts`.
- [x] Single-source usage — `usageLine(verb)` in `src/commands/help.ts`; `msg.ts` renders it on
  arg-error; the `msg` COMMANDS entry carries the full flag signature.
- [x] `--after` + `--defer` trap note on send — `src/commands/msg.ts`.
- [x] stdin body when no inline text and `!isTTY` — `src/commands/msg.ts`.
- [x] `inbox` help reworded to "fallback, not an archive" — `src/commands/help.ts`.
- [x] Attached-client hold diagnostic — `log.info` in `src/chat/deliver.ts`.
- [x] Finding 7 → rejected as external (Claude Code pane render, not our hook); no change.
- [x] Tests — `test/msg-cancel.test.ts` (cancel, replace, scope, no-task usage, no-dedup-without-task,
  trap-note, stdin), `test/help-usage.test.ts` (single-source usage, inbox wording). `bun run check`
  green (150 pass).
- [x] Docs — CHANGELOG `[Unreleased]`, README chat section.

## Что НЕ делалось

- No schema/wire change (deliberate — cancellation rides the existing ack-log).
- CLI-operator override of cancel scope (cancel any sender's task) — not needed now; easy to add.
- Daemon-side end-to-end of "a cancelled watchdog is never delivered" is covered by composition (the
  ack-log skip path is already unit-tested in delivery + stop-hook); no new daemon integration test.

## Ссылки на код

- `src/commands/msg.ts` — cancel subcommand, dedup, stdin, warn, usage
- `src/chat/store.ts` — `pendingConditional`, `appendAck` (`by: "cancel"`)
- `src/commands/help.ts` — `usageLine`, `msg`/`inbox` entries
- `src/chat/deliver.ts` — attached-client hold log
- `test/msg-cancel.test.ts`, `test/help-usage.test.ts`
