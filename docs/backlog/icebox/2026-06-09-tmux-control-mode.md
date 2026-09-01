---
title: Drive tmux through one control-mode connection instead of a process per command
description: Replace per-operation tmux process spawns and interval polling with a single long-lived control connection that pushes pane output and lifecycle events.
type: task
status: icebox
created: 2026-06-09
updated: 2026-09-01
related: docs/backlog/done/2026-06-09-ccmux-bun-port.md
priority: P2
defrost: одно из опровержений перестало быть верным — tmux начал отдавать `%output` по сессиям, к
  которым клиент не приаттачен; ИЛИ решено строить веб-терминал, которому нужен байтовый поток и
  ради него принимается клиент-на-сессию со всеми издержками ниже. Замеры внутри переснять: они
  сделаны на 15 живых сессиях и tmux 3.7c.
---

## Why now

The defrost condition written into the frozen task was "more than 20 sessions on a machine". It is
met about twice over: 38 sessions on the local machine, 53 on the development peer.

Measured on 2026-09-01 against the real fleet:

| What | Cost |
| --- | --- |
| One tmux command (process spawn + connect + exec) | ~31 ms |
| `ccmux list` across 38 sessions | 827 ms |
| Live status refresh interval in the TUI (`useFleet`) | 1500 ms |
| Pane output pushed over a control connection | **36 ms** |

Every tmux operation today is a separate process: `send-keys`, `capture-pane`, `list-sessions`,
`has-session`. "Live" is an interval that re-spawns them. The gap between "the agent answered" and
"a reader sees it" is therefore bounded by the poll, not by the event.

## Feasibility, established before planning

The frozen task named one blocking unknown — control mode historically wanted a controlling
terminal (tmux issue #3085) — and made `-CC` the mechanism throughout. Probed on tmux 3.7c, the
current stable, with piped stdio and no tty:

- `tmux -CC attach` → `tcgetattr failed: Operation not supported on socket`, exit 1.
- `tmux -C attach` → full protocol: `%begin/%end` framing, `%session-changed`, exit 0.

The difference is by design, not a version defect: `-CC` is control mode **plus** terminal
manipulation, so it requires a terminal; `-C` is control mode alone. The plan therefore uses `-C`.
Nothing about the installed tmux needs to change.

A long-lived `-C` connection with no client flags set pushes `%output` for pane activity and
`%window-add` / `%layout-change` / `%session-window-changed` for lifecycle, unprompted.

## Result

- One long-lived control connection per tmux server replaces the spawn-per-operation path for the
  operations it can serve, with process calls retained for everything else.
- Live status is driven by events, with the existing interval kept as a fallback rather than removed.
- Attach handoff is untouched: `tmux attach` / `switch-client` remain exactly as they are. This is
  about driving and observing tmux, never about handing a terminal to a person.

## Plan

- [x] **NOT DONE — Phase 1 — the client, wired to nothing.** `src/tmux/control.ts`: spawn `tmux -C`, parse the
      `%` protocol, correlate commands to their `%begin/%end/%error` blocks, expose events. Decode
      `%output` payloads, which arrive octal-escaped (`\015`, `\033[`) and are not raw bytes.
      Reconnect when the tmux server restarts. Flow control (`%pause`/`%continue`) because an agent
      pane can produce output faster than a reader consumes it. No caller switched over in this phase.
- [x] **NOT DONE — Phase 2 — one reader moved.** TUI live status consumes events instead of re-spawning
      `capture-pane` each tick. Pane scraping stays as the parser; it is fed by the stream rather
      than by a poll. The interval remains as a fallback and as the recovery path after a reconnect.
- [x] **NOT DONE — Phase 3 — heal reacts.** `ensure`/`heal` acts on `%session-changed`/`%exit` instead of
      noticing on the next sweep. Polling stays as the backstop.
- [x] NOT DECIDED — moot once the phases were rejected: who owns the connection — the daemon, the TUI, or one each — before Phase 2.

## Acceptance

- [x] NOT VERIFIED (the work was not done) — A control client survives a tmux server restart and resumes without a supervisor restart.
- [x] NOT VERIFIED (the work was not done) — Output faster than the reader is bounded by flow control rather than by unbounded memory.
- [x] NOT VERIFIED (the work was not done) — Live status latency is measured before and after on the same machine and session count.
- [x] NOT VERIFIED (the work was not done) — Killing a session is observed by heal through an event, with the poll disabled, and again with
      the event path disabled and only the poll running.
- [x] NOT VERIFIED (the work was not done) — `capture-pane`-based detectors keep working, because the stream feeds the same parsers.
- [x] NOT VERIFIED (the work was not done) — Attach and detach behave exactly as before for a human at a pane.
- [x] NOT VERIFIED (the work was not done) — No session identity, chat delivery guarantee or one-writer invariant changes.

## Process

- [x] 2 read-only plan validators against the real code, edits explicitly forbidden.
- [x] Findings incorporated; refined plan presented to the maintainer; **stop and wait**.
- [x] NOT VERIFIED (the work was not done) — Implementation of the approved plan.
- [x] NOT VERIFIED (the work was not done) — Authorized project gates green.
- [x] NOT VERIFIED (the work was not done) — 2 implementation validators; findings fixed; gates rerun.

## Validation outcome — the plan above does not survive it

Two independent read-only validators probed tmux 3.7c on isolated sockets and reached the same
verdict: **do not proceed with Phases 1–3.** Three of the plan's load-bearing claims are false, and
its value case was computed from three inflated numbers. Each item below was re-measured against the
live fleet rather than accepted from a report.

### Structural blockers, each established by probe

1. **"One connection per tmux server" is impossible.** `%output` is scoped to the *attached*
   session. Re-verified here: a `-C` client attached to session A sees A's output and never B's. The
   push channel therefore costs one connection **and one attached client per session**, not one per
   machine. Every cost and ownership statement above was computed against an architecture that does
   not exist.
2. **An attached control client corrupts the chat-delivery gate.** `clientTypingRecently`
   (`src/tmux/tmux.ts:309`) is what `src/chat/deliver.ts:420` consults, with a 3-second window. A
   control client appears in `list-clients` as attached, and its `client_activity` is stamped at
   attach. Since `killSession` tears down the control client of any session it stops, reconnect is
   routine — and a reconnect loop would hold that session's mail while writing the reason "a human
   typed in that pane a moment ago", with nobody there. That is the exact defect already fixed twice
   in this project. No acceptance item above tests chat delivery at all.
3. **`refresh-client -C` resizes a live human's pane.** Probed: a pane at 203x51 with a person
   attached became 80x24 when a control client sized itself, and `ignore-size` did not undo it. The
   plan specified "no client flags set", which is the dangerous configuration.
4. **"The stream feeds the same parsers" needs a terminal emulator.** `capture-pane` returns tmux's
   *rendered screen*; `%output` is the byte stream that produces it. `inputBusy`
   (`src/agent/claude/pane.ts`) reads the last rendered lines and their per-cell dim attributes to
   tell a human's typing from Claude's autosuggestion, and `capturePane(…, 30)` reads scrollback a
   stream does not have. Reconstructing that means implementing tmux's screen inside ccmux — and
   after a `%pause`/`%continue` the reconstruction is wrong until a full resync, which is a
   `capture-pane`. Fidelity degrades exactly when a pane is busiest.

### The value case, re-measured

| Claim above | Measured on the live fleet |
| --- | --- |
| "38 sessions, condition met twice over" | **15 running.** 23 rows are archived and cost nothing — the distinction this project shipped a fix for days earlier |
| "One tmux command ~31 ms" | **~10 ms** median for a cheap command, **16 ms** for the daemon's `capture-pane -e -S -30`. The 31 ms was one heavy command measured cold |
| "`ccmux list` 827 ms" | Roughly 70% of it is registry and transcript parsing, which control mode does not touch |
| "1500 ms poll vs 36 ms push" | The latency a person actually perceives is the **transcript** poll (`useTranscript`), not the pane. VISION already names the answer there: watch the JSONL |

Actual steady-state cost of the current design: **~13% of one core** for the daemon's observation
cycle (15 panes × 16 ms + `list-sessions`, every 2 s), plus ~2–3% for the TUI while it is open.
Real, modest, and not what a new protocol is for. Note also that 36 ms push against 10–16 ms per
command means the push is **slower per event**; the only number favouring the plan was 1500 ms, a
constant this project chose and can change.

## Refined recommendation

Reject Phases 1–3. The value they were reaching for is available without a new protocol, without an
attached client per session, and without touching the chat-safety gate:

- [x] NOT VERIFIED (the work was not done) — **The TUI reads the snapshot the daemon already publishes** instead of running its own
      `collectRows`, removing the TUI's tmux forks entirely. The daemon publishes it already
      (`docs/architecture/monitoring-status.md`); the TUI simply does not read it.
- [x] NOT VERIFIED (the work was not done) — **`useTranscript` watches the JSONL** instead of polling it every 1500 ms. This is the latency
      a human actually feels, and it is what VISION's trajectory item 3 already describes.
- [x] NOT VERIFIED (the work was not done) — **If the working/idle chip must be faster than 2 s, lower `STATUS_INTERVAL_MS`.** At 16 ms per
      capture the budget is there; this is a constant, not an architecture.

What stays true from the original work: `-C` rather than `-CC` is correct and was worth
establishing, and if a control connection is ever built it should serve **commands only** — that
channel does reach every session on the server and would remove the fork per operation without any
of the four blockers above.

## Заморожена, а не выполнена

Ни одна фаза не реализована и реализовывать их в текущем виде не следует. Задача возвращена в
заморозку, потому что «сделано» здесь было бы неправдой: сделан только **разбор**, и его вывод —
не делать. Всё ниже сохранено как готовый старт для того, кто вернётся к теме: четыре опровергнутых
утверждения и измеренные цифры, чтобы не начинать с нуля.

## Итог разбора: почему не делаем

This task ends in a decision rather than an implementation, and the decision is **no**. Both
read-only plan validators reached it independently against probes on tmux 3.7c, and the three
load-bearing claims of the plan above were falsified:

- `%output` is scoped to the ATTACHED session, so "one connection per tmux server" is impossible;
  the push channel costs one connection **and one attached client per session** — 15 here, 53 on the
  peer. Re-verified directly: a client attached to one session never saw another's output.
- A control client is an attached client, and the chat-delivery gate reads attached clients. Its
  activity stamp lands at attach, and `killSession` tears down its session's client on every stop —
  so reconnect is routine, and a reconnect loop would hold that session's mail while writing the
  reason "a human typed in that pane a moment ago", with nobody there. That is the defect this
  project has already fixed twice.
- `refresh-client -C` resizes a pane a person is attached to. Probed: 203x51 became 80x24 with the
  human still there, and `ignore-size` did not undo it.
- "The stream feeds the same parsers" needs a terminal emulator inside ccmux: `capture-pane` returns
  a rendered screen, `%output` is the byte stream that produces one, and the detectors read
  per-cell attributes and scrollback a stream does not have.

The value case did not survive measurement either. The defrost trigger counted 38 registry rows
where only 15 are running; a tmux command is ~10 ms rather than the 31 ms claimed, so the daemon's
observation cycle costs about 13% of one core, not the multiple that framing implied; ~70% of the
827 ms `ccmux list` is registry and transcript parsing that control mode does not touch; and the
latency a person actually perceives is the transcript poll, not the pane.

What survives and was worth establishing: `-C` rather than `-CC` is correct — the doubled flag also
manipulates the terminal and therefore needs one, which is why it fails under a daemon. If a control
connection is ever built it should serve **commands only**; that channel does reach every session and
would remove the fork per operation without any of the four blockers above.

## Что делать вместо

Recorded as a separate task rather than left inside a rejected plan:
`docs/backlog/inbox/2026-09-01-cheaper-live-status.md`.
