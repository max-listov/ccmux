```
        ___ ___ _ __ ___  _   ___  __
       / __/ __| '_ ` _ \| | | \ \/ /
      | (_| (__| | | | | | |_| |>  <
       \___\___|_| |_| |_|\__,_/_/\_\
       Cloud Code MUX
```

# ccmux

**Persistent, self-healing [Claude Code](https://claude.com/claude-code) sessions in [tmux](https://github.com/tmux/tmux) — with deterministic resume.**

A tiny tmux orchestrator / session multiplexer for terminal AI agents. Your Claude
Code sessions survive crashes, logouts and reboots, each pinned to a stable
conversation so it always resumes *exactly* where it left off — drivable from your
phone over Remote Control. One script. One daemon. No build step, no dependencies
beyond `bash` + `tmux`.

```
SESSION              STATUS    UPTIME   RC             DIR
cc-main              running   3h2m     prod-main      /home/ml
cc-gecko-chat        running   1d4h     prod-gecko-chat /home/ml/gecko-chat-bot
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
- **Phone-drivable** — each session is told how to manage its siblings via ccmux,
  so "restart gecko" from Remote Control / Telegram just works, in any language.
- **One file, ~280 lines of bash** — read it in five minutes, edit it in place.

## Install

```bash
git clone https://github.com/you/ccmux ~/ccmux && cd ~/ccmux
ln -s "$PWD/ccmux" /usr/local/bin/ccmux     # or anywhere on PATH
echo 'RC_PREFIX=local' > ~/.config/ccmux/config   # local | dev | prod
ccmux install                                # boot unit + daemon
```

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

Attach to watch/interact: `tmux attach -t =cc-api` (detach with `Ctrl-b d`).

## How it works

- **Identity = uuid.** `~/.ccmux-sessions` holds one `name|dir|uuid` per line. The
  uuid is the only identity — no PID files, no locks, no state.
- **Resume.** If the conversation's history `.jsonl` exists → `--resume <uuid>`,
  else `--session-id <uuid>`. Same thread, every time.
- **Sessions outlive the daemon.** Each runs in its own tmux session under a
  relaunch loop; the daemon only *heals* — so it can be bounced/updated without
  dropping a live conversation.
- **Exact targeting.** Every tmux op uses `=name` exact-match, and window renaming
  is locked off — so prefix-sharing names (`cc-gecko` vs `cc-gecko-eve`) never hit
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

One script, many machines: the binary is identical everywhere — only this file
differs. Update the whole fleet with `git pull`.

## License

MIT
