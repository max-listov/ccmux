# ccmux

**Persistent, self-healing Claude Code sessions in tmux — across a fleet of machines.**

A single daemon per machine keeps a fleet of long-running agent sessions alive in tmux:
it heals crashed ones, brings them back on reboot, and resumes the *same* conversation by a
pinned uuid. Sessions are full interactive `claude` processes (your subscription, Remote
Control, slash-commands, statusline) — ccmux supervises them, it does not reimplement them.

```
┌─ daemon (launchd/systemd) ─ heals every 30s, self-updates ─┐
│   tmux: cc-api   cc-web   cc-infra   …   (each = `ccmux _run` → claude, auto-restart)
└────────────────────────────────────────────────────────────┘
        ▲ ccmux list / new / attach / send / restart …          ▲ interactive TUI (bare `ccmux`)
```

## Install

One command — installs `bun` if missing, downloads the latest verified bundle, drops a
`ccmux` shim on your `PATH`, and starts a self-updating daemon:

```bash
curl -fsSL https://github.com/max-listov/ccmux/releases/latest/download/install.sh | bash
```

Set the boot label / RC prefix with `CCMUX_RC_PREFIX=prod` (default `local`). Re-running is
safe — it just refreshes to the latest release. Requires macOS (launchd) or Linux (systemd)
and `tmux`.

## Use

```bash
ccmux                      # interactive fleet TUI (add -f for fullscreen)
ccmux list                 # managed sessions + live status/uptime
ccmux new cc-api ~/code/api   # create + start a session (pins a fresh uuid)
ccmux send cc-api '/compact'  # PRESS KEYS in a session (slash commands) — see msg for writing to an agent
ccmux restart cc-api       # bounce it (survives killing the caller)
ccmux restart --all        # bounce EVERY session, one at a time (TUI: R) — picks up new rules/MCP/release
ccmux mode cc-api auto     # per-session permission-mode override (see Permissions)
ccmux stop|start|rm cc-api # lifecycle (rm keeps the jsonl history)
ccmux transcript cc-api --json --tail 50   # conversation history as JSON
ccmux doctor               # health check: bins, config, daemon
ccmux completions zsh > "${fpath[1]}/_ccmux"   # shell completions (bash|zsh|fish)
ccmux help                 # full command list
```

Attach to a session like any tmux pane: `tmux attach -t cc-api` (detach with `Ctrl-b d`), or
press Enter on it in the TUI.

### Adopt an external session

A `claude` you started by hand (outside ccmux) shows up in the TUI under *external*. Adopt it
to let the daemon manage it:

```bash
ccmux adopt <uuid> --fork       # safe copy under a new uuid (original untouched)
ccmux adopt <uuid> --takeover   # take over the original (kills the live writer)
```

### Which sessions still need a restart

Everything that shapes an agent — its system prompt, the chat wiring, the permission mode, the
supervisor code — is injected **at launch**, so a change lands only on the next restart. ccmux says
so when you act (`applies on: ccmux restart …`), but a line that scrolls away is not a state you can
check later.

So each launch records what it used, and `ccmux list` / `ccmux fleet` compare that against what a
launch right now would produce:

```
SESSION     MODEL    CTX            STATE  UPTIME  RESTART    RC
cc-api      Opus 5   180k/1M 18%    idle   2d1h    chat,mode  local-api
```

The column names *what* would change — `code` (newer ccmux), `chat`, `mode`, `modules`, or `config`
(anything else in the launch recipe, e.g. a reworded prompt). Empty means a restart would change
nothing. Deliberately **not** a version comparison: a release that didn't touch the prompt would flag
every session for nothing, while `ccmux chat on` doesn't move the version at all yet certainly needs
a restart. A session with no record yet (launched by an older ccmux) shows nothing — unknown is never
displayed as stale.

## How it works

- **One daemon per machine** (launchd `com.<prefix>.ccmux` / systemd `ccmux.service`) heals the
  fleet every 30s and starts it on boot. It runs the prod bundle, not your source.
- **Each session** is a tmux session whose foreground process is `ccmux _run <name>` — a tiny
  supervisor loop that launches `claude` and relaunches it on crash (exponential backoff). So an
  agent crash just comes back; killing a session is the only way to stop it.
- **Deterministic resume:** every session pins a fixed uuid (`--session-id` first, `--resume`
  after) → no session-selection picker, no accidental second conversation. Claude 2.1.x adds a
  *separate* blocking "Resume from summary?" prompt for large/old sessions that would strand an
  unattended (daemon-healed) resume at a menu — input then lands on the menu, not the
  conversation. The supervisor auto-answers it per `resumePicker` in the machine config:
  `full` = resume full, keep ALL context (default) · `summary` = resume compacted · `off` =
  leave it for a human.
- **Follow the fork:** Claude itself does NOT keep a uuid forever — running out of context
  forks the conversation to a new session id (new jsonl, old tail copied). Each heal pass
  detects that the conversation moved (the fork inherits the session's `-n` title in its first
  lines) and re-pins the registry, so previews, transcripts and the next restart follow the
  live conversation instead of a dead file.
- **jsonl is the source of truth** for the conversation (transcript, tokens, "where it stopped");
  the pane is scraped only for live status.

## Permissions

Two levels — a machine default plus an optional per-session override:

- **Machine default** — `permissionMode` in the machine config (`~/.config/ccmux/config` /
  `machine.json`). Applies to every session the daemon launches. A personal box typically runs
  `bypassPermissions`; a shared/server box stays `auto`.
- **Per-session override** — `ccmux mode <name> <mode|default>` pins one session to a different
  mode than the box (e.g. box is `bypassPermissions`, but a client-prod session stays `auto`).
  `default` clears the override → the session inherits the machine default again. The mode is a
  launch-time flag, so **`ccmux restart <name>` applies it** (a running session keeps whatever it
  started with — you can't switch into `bypassPermissions` at runtime).
- **Root guard (servers):** under a root daemon, escalated modes (`bypassPermissions`/`dontAsk`)
  are downgraded to `auto` at launch — whether they came from the machine default or a session
  override — so a config edit can't hand a server session host-wide power.

Modes match `claude --permission-mode`: `auto`, `plan`, `acceptEdits`, `manual`, `dontAsk`,
`bypassPermissions`.

## Inter-agent chat

Opt-in messaging between managed sessions, so one agent can hand off to another without you relaying.

- `ccmux chat on <name>` — enable chat for a session (**default OFF**; nothing sends or receives
  until it's on, for both ends).
- `ccmux msg <to|owner> "<text>"` — message another session (delivered to its pane) or `owner`
  (you — Telegram-only, no pane); `--task X` pins a pointer. The sender is **automatic** — a session
  sends as itself, a shell as `cli`; there is no `--from`. The body may also come from stdin
  (`echo "…" | ccmux msg <to>`). Flags: `--defer` (hold until the recipient voluntarily finishes its
  turn — never mid-work), `--after <sec>` (deliver no sooner than N seconds from now — a timer;
  a self-watchdog should use bare `--after`, not `--after --defer`), `--on-behalf-of <who>` (relay
  someone's authority honestly, without spoofing the sender; router/cli only).
- `ccmux msg cancel <task>` — drop your still-undelivered mail for a task (an armed `--after`
  watchdog or a queued `--defer`). Re-arming a conditional message with the same `--task` also
  replaces the prior undelivered one automatically, so watchdogs don't pile up.
- `ccmux inbox [name]` — read a session's still-undelivered messages and mark them read (`--peek`
  doesn't). It's the fallback for held/offline mail, **not** an archive — a message already pushed
  into a pane isn't here.
- `ccmux chat log [-n N] [--fleet]` — the exchange log: what arrived **and** what this machine sent
  to other machines (including sends that never left). `--fleet` merges every machine's log into one
  time-ordered stream; `--json` for consumers.

**Delivery.** The daemon push-delivers each message into the recipient's pane as its next turn,
tagged `[chat from <name>]` so the agent treats it as a peer, not you. It **never injects while the
recipient is at a selection menu** (that would pick an option it didn't choose) or while a human is
attached; a *busy* recipient just gets it queued at its next turn boundary. Delivery is two-track:
immediate mail flows in order, while **deferred** (`--defer`) and **time-delayed** (`--after`) mail is
delivered by id when its condition holds — a Claude Stop hook fires a deferred message the instant the
turn ends, or the daemon delivers it once the target is stably idle — so a pending conditional message
never blocks an immediate reply behind it. Loop/rate guards cap a runaway ping-pong. Source of truth:
`~/.ccmux-chat.jsonl` (+ `~/.ccmux-chat-cursors.json`, `~/.ccmux-chat-ack.jsonl`).

### Router sessions

A router is a session with a built-in **manager protocol** — it takes a follow-up you dictate, routes
it to the right session, waits, validates the result, re-asks on a gap, and escalates to you **only**
when genuinely stuck (never nagging "continue?").

- `ccmux new <name> <dir> --router` — create a router (enables chat + carries the protocol).
- `ccmux router on|off <name>` — promote/demote an existing session (applies on next `restart`).

It delivers every follow-up with `--defer` (so targets are never interrupted), carries your authority
with `--on-behalf-of owner`, and arms a `--after` **watchdog** per dispatch — so a target that finishes
but forgets to report back doesn't strand it: the timer wakes the router, it checks the target's
transcript, and closes or escalates on its own. The protocol lives in code (`promptModules`), resolved
fresh at each launch, so an update reaches every router on its next restart.

**Telegram mirror (one-way).** Add to machine.json to forward every message to a bot — a group, a
DM, or a forum topic:

```json
"telegram": { "botToken": "<@BotFather token>", "chatId": "<group/DM id>", "topicId": 42 }
```

`topicId` is optional. Absent → no mirroring (fail-soft). It's outbound only — ccmux sends to
Telegram, never reads from it.

Configure it on **every machine** and the whole fleet lands in one chat: each machine mirrors its own
ledger with its own cursor, so nothing is coordinated and nothing is duplicated. Every mirrored line
is written as a fleet address (`dev:worker → prod:api`) — with several machines in one chat, bare
names would be ambiguous, since the same session name commonly exists on two boxes. Give each machine
its own `topicId` if you'd rather keep them in separate threads.

### Coordinating agents — the whole recipe

One agent (or you, or a script) hands work to another and picks up the result. Two commands do the
waiting and the reading, so **no polling loops and no digging through JSON**:

```bash
ccmux chat on cc-worker && ccmux restart cc-worker   # 1. enable chat — it applies on RESTART
ccmux msg cc-worker "migrate the config loader" --task migrate   # 2. hand off the work
ccmux wait cc-worker                                 # 3. block until it finishes its turn (exit 0)
ccmux transcript cc-worker --last-message            # 4. take the report (full text)
```

- **Step 1 is the one people miss.** Chat framing and the Stop hook are wired at launch, so
  `chat on` alone changes nothing until that session restarts — the command tells you so. Turning it
  on across the fleet: `ccmux chat on …` for each, then one `ccmux restart --all`.
- **`ccmux wait`** shares one "is it between turns" test with deferred delivery, so the two can never
  disagree: the pane must not be working, must have finished painting, and must not be sitting on a
  selection prompt — then a turn that ended in the agent's own words settles within seconds, while a
  conversation quiet far longer than any turn's internal pause settles as **interrupted** (a session
  restarted mid-work never gets to finish that turn, and waiting for it to is waiting forever).
  Exit `0` settled either way — the line says which, because after an interrupted turn
  `transcript --last-message` returns what was said *before* the tool calls that never completed.
  `2` timed out (`--timeout N`, default 300s), `1` unknown or stopped session, re-checked while
  waiting rather than once at the start. It needs **no chat at all** — handy in any script. It also
  refuses to settle while mail addressed to that session is still on its way (the work you handed
  over has not *started*, so an idle pane is not an answer) — but not for mail that is scheduled for
  later, or that can never be delivered at all, since waiting on those is waiting for nothing.
- **Reporting back instead of waiting:** have the worker finish with
  `ccmux msg <orchestrator> "done" --task migrate --defer`. `--defer` holds the message until the
  orchestrator voluntarily ends its turn, so the report never lands mid-thought.
### Across machines

A session name only means something on **one** machine. Two boxes can each have an `api`, so a bare
name handed across a fleet is genuinely ambiguous — and an agent that resolves it locally reports to
a stranger while the one waiting hears nothing. The fix is an explicit address.

**`<machine>:<session>`** — the machine label is the `rcPrefix` you already gave that box. A bare
`<session>` still means "here", unchanged.

```json
"fleet": { "host-a": "<ssh-alias-a>", "host-b": "<ssh-alias-b>" }
```

Add that map to `machine.json` on each machine (the label is the peer's `rcPrefix`; the value is an
ssh alias **this** machine can reach). Then:

```bash
ccmux fleet                                  # every session on every machine, each line a usable address
ccmux msg host-b:api "build is green"        # message a session on another machine
ccmux wait host-b:api                        # then pick up the result
ccmux restart host-b:api --then "read docs/backlog/in-progress/x.md"
ccmux doctor                                 # verifies each alias really is the machine it's mapped to
```

Every verb that operates on an **existing** session takes an address — `start`, `stop`, `restart`,
`rm`, `send`, `msg`, `mode`, `logs`, `transcript`, `wait`, `inbox`, `chat on|off`, `router on|off`.
Creating is local by nature (`new`, `adopt` resolve local dirs and local history), so run those on
the machine itself.

- **Delivery is unchanged.** A remote send is enqueued **on the receiving machine** through its own
  `ccmux msg`, so it inherits every existing guarantee: menu/typing protection, `--defer`, rate
  limits, the ledger. Nothing bypasses the daemon.
- **The recipient sees where to reply.** Incoming cross-machine mail is tagged with the sender's full
  address and, when this machine can actually answer, the exact reply command. Agents are told to
  reply with the address **as printed** rather than infer one.
- **Trust boundary is ssh, as before.** The sender's address travels as an environment variable set
  by the transport (`CCMUX_ORIGIN`) — a routing *label*, not a credential. Anyone who can run a
  command on a box could already send as `cli`, so nothing new is granted; the label is validated to
  the same charsets as a machine label and a session name, so it cannot forge the `[chat from …]`
  tag it is rendered into, and it may not claim to be `owner`. It rides the environment rather than
  a flag on purpose: an older ccmux ignores an unknown variable, whereas an unknown *flag* would
  have been swallowed into the message body and destroyed the text.
- **Conditional mail stays local.** `--defer`, `--after` and `msg cancel` are rejected across
  machines: their dedup/cancel key is per-sender within one ledger, and two remote senders would
  tombstone each other's mail. Hand off, then use `ccmux wait`.
- **Unreachable is normal, not an error.** With no server-to-server keys, transit between two servers
  exists only while you're connected; fleet views mark such a machine and still exit 0.
- **A send that couldn't leave is retried, not lost.** Cross-machine mail carries its id, and a
  receiver ignores an id it already stored — so the daemon can safely re-send from the outbox when
  transit returns, and a retry can never duplicate (not even when the first attempt actually landed
  and only the sender read it as a failure). Retries cover plain `msg` only, stay inside a one-hour
  window, and stop as soon as one succeeds; `restart --then` is a hand-off, not a letter, and is
  never repeated. `chat log` then shows the row as *sent later, on retry* instead of *NOT SENT*.
  If your fleet can restore transit with a local command, set `transitPreflight` (an argv array) in
  `machine.json` and it runs once before a batch of retries.
- **Roll the binary out before the map.** A machine still on an older ccmux doesn't understand
  addresses — update every box first, then add `fleet` to their configs.

## Updates

**Releases are born only from tags, in CI.** `bun run release X.Y.Z "notes"` is the one
release entrypoint: it refuses a dirty tree, runs the full check, bumps the version, rolls
the `[Unreleased]` CHANGELOG section, commits, tags `vX.Y.Z` and pushes. The CI workflow
then re-runs the gate (typecheck + tests + a smoke run of the BUILT bundle), verifies the
tag matches `package.json`, builds the assets and publishes the GitHub Release atomically —
so the tag always points at exactly the code the fleet receives, and a red check means the
release physically cannot happen. There is no local publish path.

Fleet-side, both update paths share one safe core: download → **sha256-verify** against the
manifest → **preflight** (`bun <candidate> version` must load and report the right version)
→ atomic swap of the prod bundle (`.bak` kept) → bounce the daemon. **Sessions survive the
bounce** (tmux is independent of the daemon); each picks up the new code on its next
restart. A boot-guard reverts to `.bak` if a bad bundle crash-loops the daemon.

```bash
ccmux update             # update now to the latest published release
ccmux update --check     # is there a newer version?
ccmux update --rollback  # revert to the previous bundle (.bak)
```

With `autoUpdate` on (wired at install via `--release-url`), the daemon checks every
`updateCheckInterval` seconds (default 300) and applies a newer release on its own — hands-off
across the whole fleet.

## Develop

ccmux is a [Bun](https://bun.com) + TypeScript app; the TUI is [Ink](https://github.com/vadimdemedes/ink)
(React → terminal).

```bash
bun install
bun run dev            # run the CLI/TUI from source (this is `ccmux-dev`)
bun run smoke          # headless TUI e2e in a throwaway tmux pane
bun test               # tests
bun run typecheck      # tsc --noEmit
```

The dev source and the prod daemon are decoupled — editing source never touches the running prod
bundle. See `docs/architecture/` for the TUI, IO/perf model, and dev flow.

### Build & release

The release tooling lives in the source checkout only — clients ship a single bundle, no repo:

```bash
bun run stage                   # build → ~/.ccmux/staged/ccmux.js, then `ccmux update` to test locally
bun run release X.Y.Z "notes"   # the ONE release entrypoint: guards → check → bump + CHANGELOG
                                # → commit → tag vX.Y.Z → push; CI builds, gates and publishes
```

Publishing happens only in CI (`.github/workflows/ci.yml`), off the tag: gate (typecheck +
tests + a smoke run of the built bundle) → tag==version guard → assets → atomic GitHub
Release. A release is a tag `vX.Y.Z` with three assets: the `ccmux.js` bundle, a
`release.json` manifest (version + sha256 + versioned bundle url), and `install.sh`. Tags
are immutable, and the tag always points at exactly the commit the assets were built from.
The fleet tracks `releases/latest/download/release.json`.

## License

MIT © ccmux contributors
