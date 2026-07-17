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
ccmux send cc-api '/compact'  # type into a session (text or a /slash command)
ccmux restart cc-api       # bounce it (survives killing the caller)
ccmux mode cc-api auto     # per-session permission-mode override (see Permissions)
ccmux stop|start|rm cc-api # lifecycle (rm keeps the jsonl history)
ccmux transcript cc-api --json --tail 50   # conversation history as JSON
ccmux doctor               # health check: bins, config, daemon
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

## How it works

- **One daemon per machine** (launchd `com.<prefix>.ccmux` / systemd `ccmux.service`) heals the
  fleet every 30s and starts it on boot. It runs the prod bundle, not your source.
- **Each session** is a tmux session whose foreground process is `ccmux _run <name>` — a tiny
  supervisor loop that launches `claude` and relaunches it on crash (exponential backoff). So an
  agent crash just comes back; killing a session is the only way to stop it.
- **Deterministic resume:** every session pins a fixed uuid (`--session-id` first, `--resume`
  after) → no resume-picker, no accidental second conversation.
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
