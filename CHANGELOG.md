# Changelog

All notable changes to ccmux. The `[Unreleased]` section accumulates as work lands;
`bun run release X.Y.Z "notes"` rolls it into a dated version section, and CI publishes
the GitHub Release with that section as the notes.

## [Unreleased]

- Isolated dev instance: run a full second ccmux (daemon + sessions + chat) beside prod on one
  machine, fully isolated — a `tmuxSocket` config scopes every tmux call to its own server (`-L`),
  `CCMUX_HOME` overridable for its own app/log/boot-state, `remoteControl:false` keeps its sessions
  out of the claude.ai app. tmux doesn't propagate env into panes, so `new-session -e` pins the
  instance's `CCMUX_HOME/CONFIG/SESSIONS`, and the injected prompt teaches the instance's own cli
  (not the prod shim) when `CCMUX_HOME` is non-default. Scaffold + teardown via `scripts/dev-instance.sh`.
- Inter-agent chat, sender identity: the sender is automatic and unspoofable — an agent sends as its
  own session, a command-line invocation as `cli`; there is no `--from`. `owner` is a reserved
  recipient (the human — Telegram-only, no pane); the injected prompt frames `[chat from owner|cli]`
  as the human side (user-level trust) vs `[chat from <peer>]` as a fellow agent.
- Dev daemon hot-reload: `bun daemon:watch` (= `bun --watch src/cli.ts daemon`) restarts the
  process on any source change — fresh timers each time, unlike `--hot`, which re-runs the entry
  WITHOUT tearing down the old `ensure`/chat loops (they'd accumulate; proven with a `Bun.sleep`
  probe). The boot-loop guard is now skipped when running from live source (`IS_DEV`): it protects
  the auto-updated prod bundle (revert to `.bak`), has no bundle to revert in dev, and would only
  churn false "boot-loop" errors under rapid `--watch` restarts.
- Telegram chat mirror: the routing header (`from → to`, or `📩 for you — from …` for a message to
  the human) is now bold (HTML parse_mode) so who-is-talking-to-whom reads at a glance; the message
  body is HTML-escaped so `<`/`>`/`&` render verbatim and never trip a 400 that would drop the message.
- Inter-agent chat: opt-in messaging between managed sessions. `ccmux msg <to> "..."` /
  `ccmux inbox` / `ccmux chat log|on|off`, with a per-session `chatEnabled` flag (default off).
  The daemon push-delivers into the recipient's pane on a fast cadence, tagged `[chat from X]`
  (framed to the agent as a peer, not the user), gated so it never injects at a selection menu
  (would auto-pick an option — proven live) or while a human is attached; a busy recipient just
  gets it queued at its next turn boundary. In-order per recipient, no double-push across daemon
  bounces; loop/rate guards cap a runaway A→B→A. An append-only ledger (`~/.ccmux-chat.jsonl`) is
  the source of truth; multi-line bodies deliver via bracketed paste. Optional one-way Telegram
  mirror (`telegram` in machine.json → group/DM/topic; fail-soft, outbound only).

## [0.1.14] — 2026-07-19

auto-answer Claude's resume-from-summary picker so daemon-healed reboots don't strand large sessions at the menu

- Auto-answer Claude's blocking "Resume from summary?" picker on an unattended resume. Claude
  2.1.x shows this menu on `--resume` of a large/old session; a daemon-healed reboot had nobody
  to answer it, so big sessions stranded at the menu (typed input — app or tmux — landed on the
  menu, not the conversation) until a human manually restarted each one. The `_run` supervisor now
  watches the freshly-resumed pane and answers per a new `resumePicker` machine-config policy
  (`full` = keep all context [default] · `summary` = compact · `off` = leave for a human). It reads
  the option NUMBER from the pane (robust to reordering) and confirms with Enter only if the number
  key didn't. Claude-only; other agents have no such picker.
## [0.1.13] — 2026-07-17

injected prompt teaches bare ccmux shim, not the absolute bun path

- The sibling-management prompt injected into each session now teaches the bare `ccmux`
  command (the PATH shim) instead of an absolute `bun …/ccmux.js` path, so fleet agents
  call it cleanly. Falls back to the absolute invocation only when the shim isn't
  installed. The machine re-execs (supervisor, boot unit, restart-worker) stay absolute.
## [0.1.12] — 2026-07-17

per-session permission-mode override

- Sessions get an optional `permissionMode` that overrides the machine-wide default
  (`MachineConfig.permissionMode`). Undefined → inherit the machine default, so existing
  sessions and configs are unchanged. Lets one box run bypass by default while a specific
  session (client-prod, untrusted-input) stays gated at `auto`/`plan`.
- New `ccmux mode <name> <mode|default>` sets/clears the override (`default` = inherit the
  machine default). It's a launch-time flag → `ccmux restart <name>` applies it.
- The root-guard is unchanged and still applies to the resolved mode: under a root daemon,
  escalated modes (`bypassPermissions`/`dontAsk`) still downgrade to `auto`, whether they came
  from the machine or the session.
## [0.1.11] — 2026-07-16

transcript whole-session composition stats

- transcript: whole-session `stats { messages, user, assistant, toolCalls, thinking }` on every
  `--json` response, counted over the ENTIRE JSONL (not just the loaded window) and cached by
  mtime — idle sessions cost nothing, active ones recompute only when they move. Lets a viewer
  show true session composition that doesn't drift as you paginate.
## [0.1.10] — 2026-07-16

transcript backward pagination — infinite-scroll-up

- transcript: backward pagination for infinite-scroll-up. `transcript --json --before <line>
  --limit <n>` returns the `n` lines ending just before `<line>` (line-based, so it's robust to
  lines that carry no message — blank / folded tool_result), and every response now carries
  `window { firstLine, lastLine, reachedStart }` so a consumer can page older until line 1.
  `parse` gained an optional `endLine` upper bound (claude + codex parsers).
## [0.1.9] — 2026-07-16

transcript: full tool input + result output for the expanded card

- transcript: `TranscriptMessage` gains `input` (the tool_use input as pretty JSON — the actual
  command/args) and `resultText` (the paired tool_result's full output), both clipped to the
  display text limit. Consumers can now render a real request→response body per tool call
  instead of only the one-line summary. Claude + Codex parsers emit both; null for non-tool
  messages and still-running calls.
## [0.1.8] — 2026-07-14

release pipeline v2 — CI-only publishing

- Release pipeline v2: releases are born only from tags via CI (gate: typecheck + tests +
  bundle smoke); local `--publish` removed; `bun run release X.Y.Z "notes"` is the one
  ceremony (clean-tree guard → check → bump + changelog → commit → tag → push).
- Pre-push git hook runs `bun run check` (wired via `core.hooksPath`).
## [0.1.7] — 2026-07-14

- Follow the fork: the registry re-pins a session to the new session id when Claude Code
  forks the conversation (out-of-context continuation) — previews, transcripts, activity
  and the next restart follow the live conversation instead of a dead file.
- External discovery ignores processes living inside managed panes (a fork leaves the
  pane's stale `--resume` argv looking like a live external session showing a dead
  conversation).
- TUI: fleet sorts by last conversation activity (minute-bucketed, no per-tick reshuffle);
  cards show the activity age (`5m ago`) next to uptime; selection follows the session
  (uuid), not the list position.

## [0.1.6] — 2026-07-11

- Configurable permission mode (all Claude Code modes) in machine.json; escalated modes
  are downgraded to `auto` under a root daemon (server safety guard).

## [0.1.5] — 2026-06-24

- `rcPrefix` is a free-form slug, not a `local|dev|prod` enum — the fleet grows past
  three machines.

## [0.1.4] — 2026-06-23

- Discover live external sessions by process (ps scan), not file mtime — a desktop-app
  open no longer surfaces dead sessions as live.

## [0.1.3] — 2026-06-22

- Add the bun bin dir to the daemon PATH (defense-in-depth for auto-update).

## [0.1.2] — 2026-06-22

- Fix daemon auto-update preflight (bare `bun` not in the launchd PATH).

## [0.1.1] — 2026-06-22

- Fix `ccmux install` ignoring `--release-url` over an existing config.

## [0.1.0] — 2026-06-22

- First public release: persistent self-healing Claude Code tmux sessions with
  deterministic resume, fleet daemon, TUI, GitHub Releases auto-update.
