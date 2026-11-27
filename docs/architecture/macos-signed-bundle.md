---
title: macOS Signed Bundle & Managed tmux LaunchAgent
description: How stitchmux attributes macOS TCC permissions to a single Developer ID signed stitchmux.app bundle and keeps tmux sessions alive across daemon restarts.
type: architecture
status: active
created: 2026-11-23 12:48 +08:00
updated: 2026-11-23 12:48 +08:00
---

# macOS Signed Bundle & Managed `tmux` LaunchAgent

On macOS, TCC Privacy & Security permissions (Screen Recording, Automation, Local Network) are attributed to the responsible ancestor process rather than the leaf binary. Running the supervisor directly as bare `bun` and letting it spawn `tmux` causes anonymous `bun`, `tmux`, and child CLI entries in Privacy & Security, and breaks ad-hoc permissions whenever a binary updates.

## Architecture

1. **Signed background bundle (`~/Applications/stitchmux.app`):**
   - `CFBundleIdentifier`: `com.stitchmux.app` by default (overridable via `macosBundleId` in `machine.json` or `STITCHMUX_MACOS_BUNDLE_ID`).
   - `LSBackgroundOnly: true`, `AppIcon.icns`, `NSLocalNetworkUsageDescription`, `NSAppleEventsUsageDescription`.
   - Thin C launcher (`Contents/MacOS/stitchmux-launcher`): enforces `getppid() == 1` in production builds (exits `125` on direct shell invocation so shell callers cannot borrow the bundle's TCC permissions), checks every `sigprocmask`/`sigaction`/`posix_spawnattr_*` return code (exits `126` on syscall failure), spawns `argv[1..]` via `posix_spawnp` **without** `POSIX_SPAWN_SETEXEC` and **without** `responsibility_spawnattrs_setdisclaim`, forwards `SIGTERM`/`SIGINT`/`SIGHUP`/`SIGQUIT`, waits with `waitpid`, and exits with the child status (`128 + sig` on signal death).
   - Signed strictly with a `Developer ID Application` certificate (fail-closed; ad-hoc signing is refused). Installed atomically from a `*.install.noindex` staging directory using Darwin `renameatx_np(RENAME_SWAP)` with `codesign --verify --strict` before and after the swap and rollback on failure.
   - Ordinary JS auto-updates (`src/release/update.ts`) replace only `stitchmux.js` and never rebuild or re-sign `stitchmux.app`.

2. **Two separate LaunchAgents (`com.stitchmux.daemon` and `com.stitchmux.tmux`):**
   - `com.stitchmux.daemon.plist` runs `stitchmux-launcher <bun> <bundle> daemon`. The launcher wrapper is added only inside `renderLaunchdPlist`, never in `bootArgv()`, keeping the CLI PATH shim (`~/.local/bin/stitchmux`) unchanged.
   - `com.stitchmux.tmux.plist` runs `stitchmux-launcher <tmuxBin> -u [-L <socket>] -D` with `KeepAlive: true` (survives `~/.tmux.conf` with `exit-empty on`), `ThrottleInterval: 10` (prevents busy-loop when a socket is already occupied), `ProcessType: Background`, and full `EnvironmentVariables` (`HOME`, `STITCHMUX_CONFIG`, `PATH`).
   - Separating `com.stitchmux.tmux` from `com.stitchmux.daemon` preserves the guarantee that live tmux sessions survive daemon restarts and updates while keeping their responsible ancestor alive under `stitchmux.app`.

3. **Login startup race elimination:**
   - Because `launchd` starts `com.stitchmux.daemon` and `com.stitchmux.tmux` in parallel at login, `cmdDaemon` and `newSession` call `waitForManagedTmuxReady` on macOS whenever the managed tmux LaunchAgent plist is present.
   - Readiness probes `tmux display-message -p '#{pid}'` (which never auto-starts a server) and fails closed on timeout instead of spawning an unmanaged rogue tmux server.
   - Dev/isolated instances using a dedicated `tmuxSocket` (`ownsInstallation() === false`) do not touch or wait on the production `com.stitchmux.tmux` LaunchAgent.

4. **Migration & cutover from an existing unmanaged `tmux` server:**
   - Migrating an existing launchd plist on macOS requires `launchctl bootout` + wait-for-unload + `launchctl bootstrap` (`kickstart -k` alone reuses launchd's cached job definition). `installBoot` and `restartBoot` perform this reload when launchd's loaded program differs from the on-disk plist.
   - If an unmanaged `tmux` server already holds the default socket during `stitchmux install`, `installBoot` writes and enables `com.stitchmux.tmux.plist` without killing active sessions. Ownership transfers cleanly to `com.stitchmux.tmux` on the next planned `tmux kill-server` + `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stitchmux.tmux.plist` or reboot.
   - `stitchmux doctor` inspects `stitchmux.app` signature validity, `com.stitchmux.tmux` LaunchAgent state, and whether the running tmux server's responsible PID resolves to `stitchmux.app`.
   - Linux (`systemd`) is completely unaffected.
