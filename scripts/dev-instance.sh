#!/usr/bin/env bash
# Scaffold an ISOLATED dev ccmux instance beside prod — its own tmux server (-L), registry, chat
# store, log and boot-state, and RC turned OFF so its sessions never surface in the claude.ai app.
# Run it, then `source` the printed exports (or `eval "$(scripts/dev-instance.sh --env)"`) and use
# `bun run src/cli.ts <cmd>` for the dev instance. See docs/architecture/tui-and-dev-flow.md.
#
#   scripts/dev-instance.sh          # scaffold ~/.ccmux-dev + print how to drive it
#   scripts/dev-instance.sh --env    # print ONLY the export lines (for eval)
#   scripts/dev-instance.sh --down   # tear the whole instance down (server + files)
set -euo pipefail

DEV_HOME="${CCMUX_DEV_HOME:-$HOME/.ccmux-dev}"
SOCKET="ccmux-dev"
CONFIG="$DEV_HOME/machine.json"

if [ "${1:-}" = "--down" ]; then
  tmux -L "$SOCKET" kill-server 2>/dev/null || true
  rm -rf "$DEV_HOME"
  echo "dev instance torn down: killed tmux -L $SOCKET, removed $DEV_HOME"
  exit 0
fi

if [ "${1:-}" != "--env" ]; then
  CLAUDE_BIN="$(command -v claude || echo "$HOME/.local/bin/claude")"
  TMUX_BIN="$(command -v tmux)"
  mkdir -p "$DEV_HOME"
  # Working dirs for the two demo sessions (git-init'd so claude treats them as normal projects).
  for d in a b; do
    if [ ! -d "$DEV_HOME/$d/.git" ]; then
      mkdir -p "$DEV_HOME/$d"
      (cd "$DEV_HOME/$d" && git init -q && printf '# dev-%s\n' "$d" > README.md)
    fi
  done
  # Only (re)write the config if missing — never clobber a running instance's registry.
  if [ ! -f "$CONFIG" ]; then
    cat > "$CONFIG" <<JSON
{
  "claudeBin": "$CLAUDE_BIN",
  "tmuxBin": "$TMUX_BIN",
  "tmuxSocket": "$SOCKET",
  "remoteControl": false,
  "projectsDir": "$HOME/.claude/projects",
  "rcPrefix": "dev",
  "sessionsFile": "$DEV_HOME/sessions",
  "bootLabel": "com.ccmux.dev",
  "permissionMode": "bypassPermissions",
  "ensureInterval": 30
}
JSON
    echo "scaffolded $CONFIG (tmux -L $SOCKET, RC off)" >&2
  else
    echo "using existing $CONFIG" >&2
  fi
fi

# The two env vars that pin every command to THIS instance.
echo "export CCMUX_HOME=$DEV_HOME"
echo "export CCMUX_CONFIG=$CONFIG"

if [ "${1:-}" != "--env" ]; then
  cat >&2 <<EOF

# ── drive the dev instance (after: eval "\$(scripts/dev-instance.sh --env)") ──
bun run src/cli.ts new dev-a "\$CCMUX_HOME/a"   # real claude on socket $SOCKET, RC off
bun run src/cli.ts new dev-b "\$CCMUX_HOME/b"
bun run src/cli.ts chat on dev-a && bun run src/cli.ts chat on dev-b
bun run daemon:watch                            # dev daemon from source, hot-reload
bun run src/cli.ts msg dev-b "hi"               # from a session it's that session; from a shell it's 'cli'
tmux -L $SOCKET attach -t dev-a                 # look with your eyes (detach: Ctrl-b d)
# tear down:  scripts/dev-instance.sh --down
EOF
fi
