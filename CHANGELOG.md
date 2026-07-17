# Changelog

All notable changes to ccmux. The `[Unreleased]` section accumulates as work lands;
`bun run release X.Y.Z "notes"` rolls it into a dated version section, and CI publishes
the GitHub Release with that section as the notes.

## [Unreleased]

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
