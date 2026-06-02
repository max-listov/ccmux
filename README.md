```
   ┌─┐┌─┐
   │ ││ │   ccmux · Claude Code, kept alive
   └─┘└─┘   persistent · self-healing · driveable from your phone 📱
```

> 📱 **Want your Claude Code sessions to stay alive — reachable from your phone,
> resuming the *same conversation* across every crash, logout and reboot?**
> This is for you.

# ccmux

Persistent, self-healing **Claude Code** sessions in **tmux**. Each session is pinned
to a stable conversation, so a relaunch always lands you back in the *same thread* —
not a blank one. One bash script, one daemon. No build, no deps beyond `bash` + `tmux`.

```
SESSION    MODEL     CTX              STATE    UPTIME  RC          DIR
cc-api     Opus 4.8  120k/1.0M 12%    working  3h2m    prod-api    ~/code/api
cc-web     Opus 4.8  310k/1.0M 31%    idle     1d4h    prod-web    ~/code/web
```

**What you get**
- ♻️ **Self-healing** — a daemon respawns any dead session every 30s, and re-creates them all on reboot.
- ⚓ **Deterministic resume** — each conversation pinned to a uuid; a relaunch is the *same thread*, never fresh.
- 📊 **Live fleet view** — `list` shows each session's model, context fill (used / window %) and working/idle state at a glance.
- 📱 **Phone-driveable** — every session shows up in the Claude Code app by name, full access — plus plain-language control.
- 📄 **One file of bash** — read it in five minutes, fork it in ten.

---

## 📱 From your phone

Flip Remote Control on **once** — add `"remoteControlAtStartup": true` to
`~/.claude/settings.json` — and every session ccmux launches comes up
Remote-Control-enabled, under a stable name (`prod-api`, `dev-web`, … set by `RC_PREFIX`).

Then open the **Claude Code app**: every session across every machine, by name, full
access — exactly as if you were at the terminal. Each session can also drive its
*siblings*, so straight from the app:

> *"list sessions"* · *"restart api"* · *"compact web"* · *"spin up a session in ~/code/x"*
> — in any language.

Watch a long-running agent, bounce a wedged one, start a new one in another repo —
without touching a keyboard.

---

## ⚡ Get it running

> Be honest — you're not going to hand-install a bash script in 2026.
> **Give it to your agent.** 👇

**Paste to your Claude:**

```text
Set up ccmux on this machine from https://github.com/max-listov/ccmux:
clone it, symlink `ccmux` onto PATH, write ~/.config/ccmux/config with my
RC_PREFIX (local | dev | prod), then run `ccmux install`. Register my current
project as a session afterwards.
— OR — read the script and build me a leaner version tailored to this box.
```

<details><summary>…or do it by hand</summary>

```bash
git clone https://github.com/max-listov/ccmux ~/ccmux && cd ~/ccmux
ln -s "$PWD/ccmux" /usr/local/bin/ccmux
mkdir -p ~/.config/ccmux && echo 'RC_PREFIX=local' > ~/.config/ccmux/config
ccmux install            # boot unit (systemd / launchd) + daemon
```

> **macOS:** keep the script out of `~/Desktop`, `~/Documents`, `~/Downloads` — TCC
> blocks `launchd` from exec'ing there. Session *working dirs* under those are fine.

</details>

---

## 🤖 For the agent — the whole thing, dense

Drive it, or reimplement it. **Command surface:**

```
ccmux new <name> <dir>     register + start · pins a fresh uuid
ccmux list                 model · context fill % · working/idle · uptime · RC
ccmux send <name> <keys>   type text or a /slash into a session
ccmux logs <name> [n]      dump its pane
ccmux start|stop|restart   lifecycle (stop/rm of self needs --force)
ccmux rm <name>            unregister · jsonl history kept on disk
ccmux install|uninstall    daemon boot unit (install also grabs jq, for context size)
```

**Invariants that make it correct — keep these if you rebuild it:**

- ⚓ **uuid = identity.** `~/.ccmux-sessions` holds `name|dir|uuid` per line. Resume is
  `--resume <uuid>` when the transcript exists, else `--session-id <uuid>`. Same thread, always.
- 🔗 **realpath the dir** before encoding the transcript path — Claude resolves symlinks
  (`/tmp`→`/private/tmp`, mounts), so a raw path misses the `.jsonl` and silently forks.
- 🎯 **`=name` exact tmux targeting** + window-rename locked off — so `cc-api` never hits `cc-api-v2`.
- 🛟 **sessions outlive the daemon** — each runs its own relaunch loop (backoff 2s→60s, then
  one `--fork-session` to unwedge). The daemon only *heals*, so it can be bounced without
  dropping a live conversation.

---

## 🔒 Security

ccmux runs agents unattended and exposes them remotely — treat access as **shell access**:

- sessions run `--permission-mode auto` (they act without asking) → **trusted machines/accounts only**
- Remote Control ≈ a remote shell → **protect your Claude account** (2FA)
- a session can `start`/`stop`/`rm`/`send` its siblings (the self-guard blocks only self-kill)
- `~/.config/ccmux/config` is **sourced shell** → `chmod 600`; write access = code execution
- no network listener; transcripts sit in cleartext under `~/.claude/projects`

---

MIT — fork it, gut it, rename it. 🔑
