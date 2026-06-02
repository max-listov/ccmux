```
        ___ ___ _ __ ___  _   ___  __
       / __/ __| '_ ` _ \| | | \ \/ /
      | (_| (__| | | | | | |_| |>  <
       \___\___|_| |_| |_|\__,_/_/\_\
       Cloud Code MUX
```

# ccmux

**Persistent, self-healing [Claude Code](https://claude.com/claude-code) sessions in [tmux](https://github.com/tmux/tmux) — with deterministic resume.**

A tiny tmux orchestrator / session multiplexer for terminal AI agents. Each session
is pinned to a stable conversation, so it survives crashes, logouts and reboots and
always resumes *exactly* where it left off — and you can drive every session from
your phone (see below). One script. One daemon. No build step, no dependencies
beyond `bash` + `tmux`.

```
SESSION              STATUS    UPTIME   RC             DIR
cc-api               running   3h2m     prod-api       /home/you/code/api
cc-web               running   1d4h     prod-web       /home/you/code/web
```

## Why

A bare `tmux + while-loop` keeps a process alive but loses the *conversation* on
every restart. ccmux pins each session to a stable `uuid`, so a relaunch does
`claude --resume <uuid>` and you continue the same thread — across crashes and
reboots. One background daemon heals the whole fleet; you add sessions with one
command, never by editing a unit file.

- **Deterministic resume** — uuid-pinned conversations, even two in the same dir.
- **Self-healing** — a single daemon re-spawns any session that dies, every 30s.
- **Survives reboot** — installs a `systemd` (Linux) / `launchd` (macOS) boot unit.
- **Phone-drivable** — drive any session from the Claude Code app (see below).
- **One file of bash** — no build, no deps; read it in five minutes, edit it in place.

## Install

Requires [Claude Code](https://claude.com/claude-code), `tmux`, and `bash` on `PATH`.

```bash
git clone https://github.com/you/ccmux ~/ccmux && cd ~/ccmux
ln -s "$PWD/ccmux" /usr/local/bin/ccmux           # or anywhere on PATH
mkdir -p ~/.config/ccmux
echo 'RC_PREFIX=local' > ~/.config/ccmux/config   # local | dev | prod
                                                  # (or: cp config.example ~/.config/ccmux/config && edit)
ccmux install                                     # boot unit + daemon
```

Remove it all later with `ccmux uninstall` (your sessions file + history stay on disk).

> **macOS:** don't clone under `~/Desktop`, `~/Documents` or `~/Downloads` — those
> are TCC-protected and the `launchd` daemon can't *exec* a script located there
> (`Operation not permitted`). `~/ccmux` or anywhere else in `$HOME` is fine. Session
> *working dirs* under those folders are okay — only the script itself must live outside.

## Usage

```bash
ccmux new cc-api ~/code/api      # register + start (pins a fresh uuid)
ccmux list                       # sessions + uptime
ccmux send cc-api '/compact'     # type into a session (text or /slash)
ccmux logs cc-api 50             # read its pane
ccmux restart cc-api             # bounce it (survives killing the caller)
ccmux rm cc-api                  # stop + unregister (history kept on disk)
```

Attach from the same machine: `tmux attach -t =cc-api` (detach with `Ctrl-b d`).

## Drive it from your phone

Turn Remote Control on **once** — add `"remoteControlAtStartup": true` to
`~/.claude/settings.json` — and every session ccmux launches comes up
Remote-Control-enabled automatically, under a stable display name
(`prod-api`, `dev-web`, …, set by `RC_PREFIX`). No per-session step.

Then open the **Claude Code app on your phone**: every session across all your
machines shows up by name, and you get full access to any of them — exactly as if
you were sitting at the terminal.

Each session is also told how to manage its *siblings* through ccmux, so
plain-language commands work from the app too, in any language:

> "list sessions" · "restart api" · "compact web" · "send /model opus to api"

So from one phone you can watch a long-running agent, bounce a wedged one, or spin
up a new session in another repo — without touching a terminal.

## How it works

- **Identity = uuid.** `~/.ccmux-sessions` holds one `name|dir|uuid` per line. The
  uuid is the only identity — no PID files, no locks, no state.
- **Resume.** If the conversation's history `.jsonl` exists → `--resume <uuid>`,
  else `--session-id <uuid>`. Same thread, every time.
- **Sessions outlive the daemon.** Each runs in its own tmux session under a
  relaunch loop; the daemon only *heals* — so it can be bounced/updated without
  dropping a live conversation.
- **Exact targeting.** Every tmux op uses `=name` exact-match, and window renaming
  is locked off — so prefix-sharing names (`cc-api` vs `cc-api-v2`) never hit
  the wrong session.

## Config

`~/.config/ccmux/config` (sourced; everything has a sane autodetected default):

```bash
RC_PREFIX=prod                 # Remote-Control name prefix (local|dev|prod)
CLAUDE_BIN=/root/.bun/bin/claude
TMUX_BIN=/usr/bin/tmux
PROJECTS_DIR=/root/.claude/projects
ENSURE_INTERVAL=30
```

One script, many machines: the script is identical everywhere — only this config
differs. Update the whole fleet with `git pull`.

## Security

ccmux runs Claude Code sessions unattended and lets you reach them remotely, so
treat access to it as **shell access to the machine**:

- **Sessions run with `--permission-mode auto`** — they take actions without a
  human approving each step. Run ccmux only on machines and accounts you trust.
- **Remote Control = full access.** With `remoteControlAtStartup` on, anyone who
  can reach your Claude account can drive every session on every machine. Protect
  that account (2FA) — RC is effectively a remote shell.
- **Sessions can manage their siblings.** Through the injected prompt an agent can
  `start` / `stop` / `rm` / `send` to other sessions. The self-guard only stops a
  session from killing *itself* (`--force` overrides); it can still affect the fleet.
- **The config is sourced shell.** `~/.config/ccmux/config` is executed by the
  daemon, so write access to it is code execution — keep it owned by you (`chmod 600`).
- **No network listener.** ccmux opens no ports; the attack surface is your Claude
  account, local tmux, and that config file. Conversation transcripts live in
  cleartext under `~/.claude/projects`.

## License

MIT
