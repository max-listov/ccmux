# ccmux

**Persistent, self-healing Claude Code and Codex sessions in tmux — across a fleet of machines.**

A single daemon per machine keeps a fleet of long-running agent sessions alive in tmux:
it heals crashed ones, brings them back on reboot, and resumes the *same* conversation by a
pinned uuid. Sessions are full interactive provider CLI processes (`claude` or `codex`) — ccmux
supervises them, it does not reimplement them. Provider-specific features remain provider-specific:
for example Claude has Remote Control/statusline, while Codex can opt into its native App Server
for structured state and chat delivery.

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

Set the RC prefix with `CCMUX_RC_PREFIX=prod` (default `local`) — **on a new machine only**. A
machine that already has a `machine.json` keeps its identity: the installer reads the prefix rather
than re-declaring it, and refuses a rename outright, because the prefix is the machine's fleet name
and changing it renames every session's Remote Control identity.

That is what makes this the **repair** command as well as the install command. Every step converges:
the bundle is fetched only when the bytes on disk differ from the manifest, the shim and boot unit
are written only when they say the wrong thing, and nothing restarts unless something actually
changed. On a healthy machine it prints *nothing to do* and writes no files. Point it at a machine
whose bundle was deleted and it comes back whole.

Requires macOS (launchd) or Linux (systemd) and `tmux`.

## Use

```bash
ccmux                      # interactive fleet TUI (add -f for fullscreen; new: Tab switches provider)
ccmux list                 # managed sessions + live status/uptime
ccmux status --json        # bounded daemon snapshot; no per-reader transcript/tmux scan
ccmux new cc-api ~/code/api   # create + start a session (returns after authoritative thread bind)
ccmux new cc-review ~/code/api --agent codex   # provider is explicit
ccmux new cc-native ~/code/api --agent codex --runtime app-server  # owned native runtime
ccmux runtime cc-native --json   # exact native turn state, without a pane/history scan
ccmux send cc-api '/compact'  # PRESS KEYS in a session (slash commands) — see msg for writing to an agent
ccmux restart cc-api       # bounce it (survives killing the caller)
ccmux restart --all        # bounce EVERY session, one at a time (TUI: R) — picks up new rules/MCP/release
ccmux mode cc-api auto     # per-session permission-mode override (see Permissions)
ccmux stop|start|rm cc-api # lifecycle (rm keeps the jsonl history)
ccmux renew cc-api         # fresh conversation, same session — the way out when its transcript is gone
ccmux transcript cc-api --json --tail 50   # conversation history as JSON
ccmux doctor               # health check: bins, config, daemon
ccmux completions zsh > "${fpath[1]}/_ccmux"   # shell completions (bash|zsh|fish)
ccmux help                 # full command list
```

`list` and `fleet` show the provider (`claude` or `codex`) explicitly. A managed identity is the
provider plus its exact fleet address, not its working directory: two providers may intentionally
work in the same project. Never choose a target by cwd, project name, or model.

Resident applications can import `readMonitoringStatus` from `ccmux/monitoring-reader` to read
the same snapshot in-process, with cancellation, deadlines and bounded concurrency—no CLI per
poll. Releases also include a self-contained `monitoring-reader.js` ESM asset and SHA-256 file.
See the [native monitoring contract](docs/architecture/monitoring-status.md) and
[resident example](examples/monitoring-reader.ts).

ccmux-managed sessions and Codex Desktop tasks are separate coordination planes. Managed sessions
use ccmux addresses, persistence, and wait state. Claude and Codex managed sessions use the ccmux
chat ledger; delivery follows the selected provider/runtime boundary. Desktop tasks use the task tools and
native task IDs exposed by the Desktop app. ccmux does not mirror the Desktop task ledger; sharing a
cwd does not bridge the two planes. See [`docs/architecture/peer-routing.md`](docs/architecture/peer-routing.md).

Attach to a session like any tmux pane: `tmux attach -t cc-api` (detach with `Ctrl-b d`), or
press Enter on it in the TUI.

### Owned native Codex runtime

`new --agent codex --runtime app-server` runs one native Codex App Server under the existing
supervisor. Its native terminal client attaches to the same writer with `resume --remote`.
Codex CLI 0.147.0 or newer, Unix transport and native remote resume support are required; use
your existing provider login and permission settings. Ordinary TUI sessions are unchanged.

CCMux reads native working/idle/approval/input events, preserves the same conversation UUID
across restart, and routes `msg`/`--defer`/`wait` through native turn boundaries. It never
submits over a partial composer or approval dialog. A disconnected/expired observation is
unknown, not idle. This does **not** attach the official Desktop app to the owned runtime or
migrate its existing conversations.

Resident consumers can import `readCodexRuntime` from `ccmux/codex-runtime-reader`, or use the
release's self-contained `codex-runtime-reader.js` and SHA-256 asset. See the
[ownership and read contract](docs/architecture/owned-codex-runtime.md) and
[resident example](examples/codex-runtime-reader.ts).

### Adopt an external session

The external inventory is **off by default** — it is evidence gathered for a decision (adopt, fork,
take over), and its cost tracks how much transcript history the box has accumulated rather than how
many sessions it runs. Press `x` in the TUI to turn it on for the current run, or set
`externalInventory: true` in `machine.json` to make it the machine's starting answer. While it is
off the header says `external off`, so an absent section is never mistaken for an empty one.

Once on, a provider CLI or persisted Codex task outside ccmux shows up under *external* with
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

`ccmux external --json` exposes independent `turnState` evidence from an accessible native Codex
App Server; a shared writer lock never means the thread is working. States include working, idle,
approval/input wait and unknown, with provenance and a five-second expiry. Unsupported or
unavailable runtimes remain unknown. See the [external read contract](docs/architecture/external-session-ownership.md#external-turn-observation).

### Reaching another machine

An address is `<machine>:<session>` and it never says how the call travels. Two transports carry it,
and the choice is per direction in `machine.json`:

| Transport | Use it for | Configured by |
|---|---|---|
| ssh | machines that can address each other | `fleet: { <machine>: <alias> }` |
| stitchwire | a machine with no stable address — it dials out and keeps the link | `wire: { peers: [<machine>] }` |

A machine in `wire.peers` is reached over the wire even when it also has an ssh alias, so the wire is
adoptable one direction at a time.

Two things are worth knowing before diagnosing a route:

**Check with the overrides off.** `ssh -o ControlPath=none -o IdentityAgent=none -o BatchMode=yes
<peer> "ccmux --version"`. Multiplexing lets ssh reuse a master connection somebody else opened and
succeed without authenticating; `IdentityAgent` in `ssh_config` points it at an agent socket whatever
the environment says. Unsetting `SSH_AUTH_SOCK` is not a substitute for the flag: `IdentityAgent` overrides the variable, so
that form answers according to whether the configured socket is alive right now. Leave any of them out
and a green check can be measuring somebody else's live connection. How your machines authenticate to each other is your ssh configuration's business — a key
file in `~/.ssh` is not evidence of being authorised on the far end.

**A dead agent socket outlives the login that made it.** `SSH_AUTH_SOCK` belongs to that login, and a
supervised session outlives it; afterwards ssh fails on a socket with nothing behind it — sometimes hanging to a
timeout, sometimes with an instant `Permission denied`, so the response time tells you nothing. ccmux drops the variable at launch when the socket is already gone, and logs
it. A live socket is never removed — it may be the only credential the machine has.

**A failed hop is not a lost message.** Cross-machine `msg` writes to the outbox before the hop and
retries for an hour; the sender is told the message is queued and that nothing is required of it.

### When a session is waiting on you

An agent can raise a blocking menu at startup — "is this folder trusted?", "resume from summary or
full?" — and a supervised session has nobody sitting at it. Typed input lands on the *menu*, not the
conversation, so the session stays there indefinitely.

ccmux answers the ones its policy covers and **reports the rest instead of hiding them**:

```
SESSION     AGENT   MODEL    CTX      STATE   UPTIME  RESTART  RC
agent-a     claude  Opus 5   -        prompt  2m      -        host-a-agent-a
```

`prompt` is not a variant of `idle` — it is the opposite. Every other signal reads such a session as
calm (still pane, no tool running, agent not speaking), which is exactly how a fleet-wide restart can
leave half the sessions unable to act while the list reads healthy. The TUI names the question, and
`ccmux doctor` lists every session stranded this way.

`trustPrompt` in `machine.json` sets how much the supervisor answers on your behalf:

| level | answers |
|---|---|
| `off` | nothing — a human will |
| `folder` *(default)* | the plain "do you trust this folder" question |
| `declared` | also folders that pre-approve tool permissions in their own `.claude/settings.local.json` |

The split is deliberate. Registering a session that points at a directory *is* your declaration that
you trust it, so asking again — of nobody — only strands it. Permissions that a **file inside the
repo** declares are a different question that nobody has answered yet, and granting them silently
would hand any checked-in settings file whatever it asks for. That one stays opt-in.

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

The column names *what* would change — `rules`, `mcp`, `env`, `chat`, `mode`, `modules`, or `config`
(anything else in the launch recipe, e.g. a reworded prompt or changed flags). Empty means a restart
would change nothing.

The first three are things the agent reads at startup from **outside** argv and never re-reads: its
global rule set (and whatever that imports, resolved for this machine), its MCP configuration, and
the env file the session declares. They are hashed, not
stored, and hashed narrowly — the `mcpServers` table rather than the file it lives in, because agents
rewrite those files constantly and a column that lights up hourly stops being read. Without them the
column answered "a restart would change nothing" while knowing only a quarter of the inputs: a
fleet-wide rule change once left every session running yesterday's rules behind a clean column, and
the only remedy left was bouncing two dozen sessions blind.

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
- **Where things live** — four roots, split by lifetime, so "can I delete this?" is answered by
  the path and not by guessing:

  | root | holds | if you delete it |
  |---|---|---|
  | `<config>/ccmux/` | `machine.json` | this machine's identity is gone |
  | `<state>/ccmux/` | `sessions.jsonl`, chat + outbox, `status/`, log | sessions are orphaned |
  | `<data>/ccmux/` | `app/` — the bundle everything launches | the daemon cannot restart; restore with the installer |
  | `<cache>/ccmux/` | `staged/`, `releases/` | one `ccmux update` rebuilds it |

  The bundle sits in the durable root rather than the cache on purpose. "Deleting the cache costs
  one `ccmux update`" is false when the cache holds the tool: that command *is* the deleted file, and
  the boot unit launches it too, so a wiped cache leaves a machine that cannot repair itself and
  cannot be restarted — one that looks healthy for exactly as long as the already-loaded process
  keeps running. `ccmux doctor` reports a missing bundle, and the daemon restores one it finds gone.

  The roots come from the standard config/state/data/cache environment variables with the usual
  platform defaults, so a fresh machine lands correctly with nothing written by hand. `stateDir`
  in `machine.json` overrides the state root; that is the single knob an isolated instance flips.
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
- **Under a root daemon, escalated modes need the machine to declare itself.** They are blocked
  twice: ccmux downgrades them, and the agent independently refuses to start as root
  (*"--dangerously-skip-permissions cannot be used with root/sudo privileges"*). Undeclared,
  `ccmux mode` refuses the mode outright rather than storing a setting that can never take effect,
  `doctor` names anything already configured that way, and the launcher keeps downgrading as a last
  line of defence for a hand-edited config.

  A machine that accepts unrestricted root agents sets `"allowEscalatedUnderRoot": true` in its
  `machine.json`. That lifts **both** halves — no downgrade, and ccmux passes the agent the
  environment variable its own root check reads. Read it plainly before setting it: that variable
  declares the process sandboxed, which on a bare server is not true. What the flag really says is
  *"I accept an agent acting as root here with nothing to approve it"*. Legitimate for a box whose
  owner wants exactly that; expensive to enable by accident, which is why it is explicit, per
  machine, and never a default. The alternative remains running the daemon as a non-root user.

Modes match `claude --permission-mode`: `auto`, `plan`, `acceptEdits`, `manual`, `dontAsk`,
`bypassPermissions`.

## Session events

`ccmux list` says what is true now. The feed says what happened.

```bash
ccmux events                       # recent transitions, newest last
ccmux events --follow --json       # stream them as they occur
ccmux events --since <iso> --json  # catch up after a disconnect
ccmux events --session cc-api      # one session only
```

Each line is a transition — `turn-start`, `turn-end` (with how long the turn ran), `waiting` at a
blocking menu, `resumed`, `session-start`/`session-stop`/`session-blocked` — carrying the full
`machine:session` address, the provider and the thread id.

It exists because polling `list --json` cannot answer the question anything reactive actually asks: a
turn that starts and ends between two polls leaves no trace, and "this ran for thirty minutes" is not
recoverable from two snapshots. Nothing is executed on an event: the turn hook is what the agent
waits on to finish a turn, so a consumer's command there would stall agents. The feed is written;
reacting is the reader's job.

Delivery is at-least-once — `--since` re-reads its boundary instant rather than risking a gap — so
every event carries an `id` to dedupe on. `sessionEvents` in `machine.json` and `eventsEnabled` per
session switch it off; both default on.

A transition is only heard by whoever was listening at the time, and a consumer restarting is
routine — so the counter beside `working` comes from the snapshot instead. `list --json` and
`fleet --json` carry **`turnStartedAt`**: when the turn that is running right now began.

```jsonc
{ "name": "cc-api", "state": "working", "turnStartedAt": "2026-08-25T07:41:12.004Z" }
```

An absolute instant, never an elapsed count — elapsed is only true at the moment it is produced, and
a snapshot that crossed a network and sat in a cache is short by exactly the delivery time. Subtract
it from your own clock and tick locally. Null means the session is not in a turn, or is in one whose
start nobody recorded (a provider without turn hooks); `state` tells those apart. `fleet --json`
reports it for remote machines too.

Details in [`docs/architecture/session-events.md`](docs/architecture/session-events.md).

### Is everything rolled out?

`ccmux fleet` answers both halves now — which version each machine runs, and whether that is the
right one. The supervisor already fetched the release manifest on every tick and threw the answer
away; it is written down instead.

```bash
ccmux fleet          # latest release, then each machine with how far behind it is
ccmux fleet --json   # latest / latestAt at the top; per machine: release{} and behind
```

Each machine reports **facts about itself**: what is installed, the newest release it managed to
read, when it last tried and whether that worked. The **yardstick is one per answer** — the best
release any machine could report — and every machine is measured against that, never against its own
memory. A box that lost its route to the release feed remembers an old "latest", and judging it by
that memory reports it as *less* behind than it is, sometimes as up to date: the error would point in
the reassuring direction, in exactly the case someone is looking because something seems wrong.

`behind` is `patch` / `minor` / `major`, and the breaking axis is the **leftmost non-zero position**:
below 1.0.0 a minor bump is the breaking one, which is what `^0.23.0` encodes. Reading the positions
literally would make `major` unreachable for a project's whole pre-1.0 life and file every breaking
jump under `minor`.

Three states stay apart, and the third is what a bare version number hides: **behind**, **current**,
and **nobody has been able to check** (`latest: null`, or `ok: false` beside a remembered version).
The last one must never be drawn as current.

## Session environment

A session's environment is a **declared recipe**, not whatever the supervisor happened to inherit.

```bash
ccmux env-file cc-api .env               # declare (relative to the session dir, or absolute)
ccmux env-file cc-api --none             # clear it — base environment only
ccmux env-file --adopt --dry-run         # what is still inheriting undeclared; drop --dry-run to declare it
ccmux new cc-api ~/src/api --env-file .env
```

It applies on the next restart, like `mode` and `chat`, and a change to the file shows as `env` in
the `RESTART` column.

This exists because the opposite was already happening, undeclared. `_run` is a Bun process whose cwd
is the session's directory; the runtime loaded that directory's `.env` into itself and the launcher
copied its environment into the agent — so a project's secrets reached the agent **and every process
the agent spawns** (MCP servers, shell tools, subagents), invisibly. On the first fleet this was
measured against, 5 of 14 sessions were carrying project variables that way, API keys among them.

Now the pane runs with `--no-env-file` and the recipe subtracts those names, so only the declared file
gets through — and `CCMUX_*` names are refused from it, because a session grants a project variables,
it does not let a project reconfigure its supervisor. A declared file that is missing costs a
variable, never the session: `list` and `doctor` say so instead. Sessions started before this keep
what they were launched with until they restart; `ccmux doctor` lists exactly those, and the list
emptying is what "the migration is done" means.

## Inter-agent chat

Two levels, exactly like the permission mode: a machine default plus an optional per-session
override.

```bash
ccmux chat on cc-api        # this session talks, whatever the machine says
ccmux chat off cc-api       # this session stays silent
ccmux chat default cc-api   # clear the override → inherit the machine
```

`chatEnabled` in `machine.json` is the default for sessions that do not override it. It ships **off**
— chat traffic is never implicit — but turning it on is now one decision per machine instead of one
per session, which is what stops a forgotten session from being discovered when a peer does not
answer. A session created after that is born able to talk; rows that already carry an explicit value
keep it until you clear the override.

Chat framing and the Stop hook are launch-time, so all three commands apply on the next restart —
and flipping the machine default marks the affected sessions in the `RESTART` column.

### Address by what a session DOES, not by what it is called

A session name is chosen once, and it is usually the project's. A project has several sessions and
only one of them owns any given decision — so an address picked from a project name **resolves, is
delivered, and exits zero**, onto the neighbour. Nothing reports a problem, which is what makes it
expensive: on this fleet it cost an hour of believing a report had reached a contract's owner.

```bash
ccmux role cc-api contract-owner        # declare — applies at once, no restart
ccmux role                              # what answers to what, on this machine
ccmux msg host-a:@contract-owner "…"    # address by role
```

`@` is a separate namespace, not decoration: without it a role and a session name would compete for
one space. **A role matching two sessions refuses the address** and shows both — with their
directories, what each last said, and the exact address to retry with — rather than silently picking
one. A session without a role is addressed by name exactly as before.

It is deliberately cheap to change and never marks a session for restart: a second name that costs
something to correct is one people put off correcting, and within a week it lies while being trusted.

### An owner outside the fleet has an address, and the hop through you is written down

A component owner can work as an agent in another product entirely — ccmux is not that product's
transport and should not pretend to be. One hop through a person is cheaper than integrating with
someone else's product; what was missing is that the hop was **unwritten**: no record, no reply
address, and no way to ask what has not come back. And with nobody to address, people addressed the
*project* — which is usually also a session name, so the message resolved and landed on a neighbour.

```jsonc
// machine.json — the value is prose, because a person is the route
{ "externals": { "contract-owner": "works in <product>; ping them in its own chat" } }
```

```bash
ccmux msg owner/contract-owner --task release "please cut a release with the fix"
ccmux inbox                                    # what has been sent out and not come back
ccmux relay owner/contract-owner --task release "shipped in 1.2.0"
```

`owner/<name>` carries no colon, so it can never be read as `<machine>:<session>`, and an undeclared
name is refused rather than invented. The letter is appended to the ledger like any other, automatic
delivery **refuses and names the route**, and the Telegram mirror hands the carrier the message with
where to take it and the one command that brings the answer back.

It is **awaiting a reply by default** — not a flag the sender has to remember, because a flag you
must remember is wrong within a week. `ccmux relay` records the answer as a relay (`on behalf of
owner/<name>`, never as that party speaking, since ccmux cannot authenticate them), delivers it to
whoever wrote, and closes the letter. Two letters want two answers; one reply cannot close both.

### Reading the log live

`ccmux chat log --json` is a snapshot — right for first paint, wrong for staying current: polling it
means re-serialising history the consumer already has, and one long message can push that single
document past a transport's cap, at which point it is not partly readable but **unreadable**, because
a cut document has no last brace.

```bash
ccmux chat log --follow --json                 # every new row as it lands
ccmux chat log --follow --since 2.145.154      # resume exactly where you left off
ccmux chat log --follow --framed               # wrapped for a transport that resumes
```

The cursor is a **position, not a time**: `<generation>.<ledger>.<outbox>`. Rows carry the timestamp
of the machine that minted the message, so many share a second and a corrected clock can move one
behind another — a time cursor would replay what you have or, silently, skip what you have not. Both
sources are append-only, so record N is record N forever. A cursor from a retired record generation
is refused rather than reinterpreted.

Every record is bounded (32 KiB, one transport chunk). An oversized body is **replaced** by a
sentence naming its real size, never cut: the route, the time and the position all survive, so the
stream keeps flowing and nothing after it is lost.

The feed is local, and a fleet view is N of them — a machine's chat log is its own two files, and
the transport that carries one carries all of them, which is how the session event feed already
reaches a dashboard. `--fleet` stays a snapshot for first paint.

The ledger tolerates a mixed fleet. A record written by a **newer** ccmux is stepped over rather than
refusing the whole file — otherwise one upgrade would take down `msg`, `inbox`, delivery and the TUI
on every machine that had not caught up yet, and there is always such a window: rollout takes minutes
and a rollback is legitimate. Its **position is kept**, because delivery cursors are positions in that
file; dropping it would shift every later index and hand a cursor written by one build to a different
message under another. `ccmux doctor` and `ccmux inbox` report how many records this build cannot
read. A record from an *older* generation still stops the read — that one needs a person to migrate
it — and a line that is not JSON still fails loudly, because that is damage, not skew.

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

**Delivery.** Managed Claude and ordinary Codex sessions use their calibrated pane adapters.
Owned App Server sessions use native `turn/start`, durable message intent and exact provider
receipts. For a deliverable target, the daemon delivers each message as its next turn,
tagged `[chat from ccmux/<provider>@<machine>:<session>#<thread-uuid>]` so the agent sees the exact
source/provider/reply identity and treats it as a peer, not you. It **never injects while the
recipient is at a selection menu** (that would pick an option it didn't choose) or while a human is
attached; a *busy* recipient just gets it queued at its next turn boundary. Delivery is two-track:
immediate mail flows in order, while **deferred** (`--defer`) and **time-delayed** (`--after`) mail is
delivered by id when its condition holds — a Claude Stop hook fires a deferred message the instant the
turn ends, or the daemon delivers it once the target is stably idle — so a pending conditional message
never blocks an immediate reply behind it. Loop/rate guards cap a runaway ping-pong. Active state is
`chat.jsonl`, `chat-cursors.json`, `chat-ack.jsonl`, `outbox.jsonl`, and
`outbox-ack.jsonl`. Records carry their generation; superseded state moves under `archive/`, because
name-only identities are never guessed into v2.

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
