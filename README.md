# ccmux

**Persistent, self-healing Claude Code and Codex sessions in tmux — across a fleet of machines.**

A single daemon per machine keeps a fleet of long-running agent sessions alive in tmux:
it heals crashed ones, brings them back on reboot, and resumes the *same* conversation by a
pinned uuid. Sessions are full interactive provider CLI processes (`claude` or `codex`) — ccmux
supervises them, it does not reimplement them. Provider-specific features remain provider-specific:
for example Claude has Remote Control/statusline, while managed Codex pane chat is not yet enabled.

```
┌─ daemon (launchd/systemd) ─ heals every 30s, self-updates ─┐
│   tmux: cc-api   cc-web   cc-infra   …   (each = `ccmux _run` → claude|codex, auto-restart)
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
ccmux                      # interactive fleet TUI (add -f for fullscreen; new: Tab switches provider)
ccmux list                 # managed sessions + live status/uptime
ccmux new cc-api ~/code/api   # create + start a session (returns after authoritative thread bind)
ccmux new cc-review ~/code/api --agent codex   # provider is explicit
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

`list` and `fleet` show the provider (`claude` or `codex`) explicitly. A managed identity is the
provider plus its exact fleet address, not its working directory: two providers may intentionally
work in the same project. Never choose a target by cwd, project name, or model.

ccmux-managed sessions and Codex Desktop tasks are separate coordination planes. Managed sessions
use ccmux addresses, persistence, and wait state. Claude managed sessions can use the ccmux chat
ledger; managed Codex delivery is rejected until its pane behavior is calibrated. Desktop tasks use the task tools and
native task IDs exposed by the Desktop app. ccmux does not mirror the Desktop task ledger; sharing a
cwd does not bridge the two planes. See [`docs/architecture/peer-routing.md`](docs/architecture/peer-routing.md).

Attach to a session like any tmux pane: `tmux attach -t cc-api` (detach with `Ctrl-b d`), or
press Enter on it in the TUI.

### Adopt an external session

A provider CLI or persisted Codex task outside ccmux shows up in the local TUI under *external* with
provider, host, full thread UUID, persisted origin and current writer evidence. Origin (`cli`,
`vscode`, `app-server`, ...) is metadata, not proof of who owns the writer now. The absence of an
observed writer is advisory; Codex ownership is accepted only when the future managed TUI actually
acquires the provider's thread lock.

```bash
ccmux adopt codex <uuid>              # one atomic resume attempt; conflict rolls back cleanly
ccmux adopt codex <uuid> --fork       # native `codex fork`; new uuid, source remains owned
ccmux adopt claude <uuid> --fork      # Claude's provider-specific fork adapter
```

Codex Desktop, editor, App Server, shared, self and unknown runtimes are never signalled. Release
the task at its source, then retry atomic adopt. A proven dedicated CLI can be taken over only with
the exact current PID printed by the local inventory:

```bash
ccmux adopt codex <uuid> --takeover --confirm-writer <pid>
```

Every action re-reads the exact provider+host+UUID row before mutating. External inventory is local;
`ccmux fleet` remains the managed-session wire. Adopted-in-place Codex sessions gain lifecycle
management but no hidden management/chat prompt is inserted into the existing conversation.

### Which sessions still need a restart

Everything that shapes an agent — its system prompt, the chat wiring, the permission mode, the
supervisor code — is injected **at launch**, so a change lands only on the next restart. ccmux says
so when you act (`applies on: ccmux restart …`), but a line that scrolls away is not a state you can
check later.

So each launch records what it used, and `ccmux list` / `ccmux fleet` compare that against what a
launch right now would produce:

```
SESSION     AGENT   MODEL    CTX            STATE  UPTIME  RESTART    RC
agent-a     claude  Opus 5   180k/1M 18%    idle   2d1h    chat,mode  host-a-agent-a
```

The column names *what* would change — `chat`, `mode`, `modules`, or `config` (anything else in the
launch recipe, e.g. a reworded prompt or changed flags). Empty means a restart would change nothing.

Deliberately **not** a version comparison. That measure lies in both directions: `ccmux chat on`
doesn't move the version at all yet certainly needs a restart, while an upgrade that only touched the
daemon would flag every session for nothing. Nor does a newer ccmux need one on its own — the prompt,
the hooks and statusline (`--settings` is inline in argv), the mode and the flags are all part of the
recorded recipe, and hooks resolve the binary when they run, so a live session picks up new
supervisor code without restarting. A session with no record yet (launched by an older ccmux) shows
nothing — unknown is never displayed as stale.

## How it works

- **One daemon per machine** (launchd `com.<prefix>.ccmux` / systemd `ccmux.service`) heals the
  fleet every 30s and starts it on boot. It runs the prod bundle, not your source.
- **Where things live** — three roots, split by lifetime, so "can I delete this?" is answered by
  the path and not by guessing:

  | root | holds | if you delete it |
  |---|---|---|
  | `<config>/ccmux/` | `machine.json` | this machine's identity is gone |
  | `<state>/ccmux/` | `sessions.jsonl`, chat + outbox, `status/`, log | sessions are orphaned |
  | `<cache>/ccmux/` | `app/`, `staged/`, `releases/` | one `ccmux update` rebuilds it |

  The roots come from the standard config/state/cache environment variables with the usual
  platform defaults, so a fresh machine lands correctly with nothing written by hand. `stateDir`
  in `machine.json` overrides the middle one; that is the single knob an isolated instance flips.
- **Each ready session** is a tmux session whose foreground process is `ccmux _run <name>` — a tiny
  supervisor loop that launches the registered provider CLI and relaunches it on crash (exponential backoff). So an
  agent crash just comes back; a fresh Codex pane briefly runs `_bootstrap` until its real UUID is
  bound, then becomes the same ready supervisor. External Codex adopt/fork reuse the same pending
  transaction: resume admission or native-fork correlation must succeed before a ready row exists.
- **Deterministic resume:** every ready session pins an authoritative uuid. Claude uses `--session-id`
  first and `--resume` after; Codex persists a unique bootstrap marker and all later launches use
  `codex resume <uuid>`. No cwd/mtime inference or session-selection picker is involved. Claude 2.1.x adds a
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

- **Machine default** — `permissionMode` in `~/.config/ccmux/machine.json`. Applies to every
  session the daemon launches. A personal box typically runs
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

**Delivery.** Claude is the currently calibrated managed chat recipient; managed Codex targets fail
explicitly until its pane adapter lands. For a deliverable target, the daemon push-delivers each
message into the recipient's pane as its next turn,
tagged `[chat from ccmux/<provider>@<machine>:<session>#<thread-uuid>]` so the agent sees the exact
source/provider/reply identity and treats it as a peer, not you. It **never injects while the
recipient is at a selection menu** (that would pick an option it didn't choose) or while a human is
attached; a *busy* recipient just gets it queued at its next turn boundary. Delivery is two-track:
immediate mail flows in order, while **deferred** (`--defer`) and **time-delayed** (`--after`) mail is
delivered by id when its condition holds — a Claude Stop hook fires a deferred message the instant the
turn ends, or the daemon delivers it once the target is stably idle — so a pending conditional message
never blocks an immediate reply behind it. Loop/rate guards cap a runaway ping-pong. Active state is
`chat-v2.jsonl`, `chat-cursors-v2.json`, `chat-ack-v2.jsonl`, `outbox-v2.jsonl`, and
`outbox-ack-v2.jsonl`. Unversioned files are ignored read-only archives; their name-only identities
are never guessed into v2.

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
ccmux fleet                                  # every managed session, with provider + usable address
ccmux msg host-b:api "build is green"        # message a session on another machine
ccmux wait host-b:api                        # then pick up the result
ccmux restart host-b:api                       # lifecycle only
ccmux msg host-b:api "read docs/backlog/in-progress/x.md"  # recorded hand-off
ccmux doctor                                 # verifies each alias really is the machine it's mapped to
```

Every verb that operates on an **existing** session takes an address — `start`, `stop`, `restart`,
`rm`, `send`, `msg`, `mode`, `logs`, `transcript`, `wait`, `inbox`, `chat on|off`, `router on|off`.
Creating is local by nature (`new`, `adopt` resolve local dirs and local history), so run those on
the machine itself.

- **Remote admission is exact and fail-closed.** The sender resolves provider+UUID, freezes one v2
  envelope, and pipes it to the receiver's transport-only `_chat-receive-v2`. The receiver revalidates
  machine+provider+UUID before one atomic idempotent append; old binaries reject the unknown verb
  before writing anything. Retries reuse the pinned envelope and never resolve a reused name again.
- **The recipient sees where to reply.** Incoming cross-machine mail is tagged with the sender's full
  address and, when this machine can actually answer, the exact reply command. Agents are told to
  reply with the address **as printed** rather than infer one.
- **Admission boundary is ssh; managed provenance is a process capability.** A managed runtime gets
  a rotating credential inherited by its descendants, so self-setting `CCMUX_SESSION` cannot promote
  an ordinary CLI sender. This proves ccmux process provenance, not security against a hostile process
  running as the same OS user (that user can read ccmux state). Remote receiver admission additionally
  requires the authenticated SSH process context. Provider/address fields are routing identity,
  never elevated trust.
- **Conditional mail stays local.** `--defer`, `--after` and `msg cancel` are rejected across
  machines: their dedup/cancel key is per-sender within one ledger, and two remote senders would
  tombstone each other's mail. Hand off, then use `ccmux wait`.
- **Unreachable is normal, not an error.** With no server-to-server keys, transit between two servers
  exists only while you're connected; fleet views mark such a machine and still exit 0.
- **A send that couldn't leave is retried, not lost.** Cross-machine mail carries its id, and a
  receiver ignores an id it already stored — so the daemon can safely re-send from the outbox when
  transit returns, and a retry can never duplicate (not even when the first attempt actually landed
  and only the sender read it as a failure). Retries cover plain `msg` only, stay inside a one-hour
  window, and stop as soon as one succeeds. Lifecycle commands are never queued as messages.
  `chat log` then shows the row as *sent later, on retry* instead of *NOT SENT*.
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
bun run stage                   # build → the cache's staged/ccmux.js, then `ccmux update` to test locally
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
