#!/usr/bin/env bash
# Drive the real TUI inside a throwaway tmux pane (a real pty) and dump frames after each
# keypress — the only way to e2e-test an interactive terminal UI headlessly. Safe keys
# only (nav / f / PgDn / q); never s/r/D so live sessions are untouched.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESS="tuismoke-$$"
TMUX="${TMUX_BIN:-tmux}"

wait_for() { # $1=pattern $2=tries
  for _ in $(seq 1 "${2:-30}"); do
    "$TMUX" capture-pane -t "$SESS" -p 2>/dev/null | grep -q "$1" && return 0
    perl -e 'select(undef,undef,undef,0.2)'
  done
  return 1
}
frame() { echo "── $1 ──"; "$TMUX" capture-pane -t "$SESS" -p 2>/dev/null | sed '/^[[:space:]]*$/d'; echo; }
key()   { "$TMUX" send-keys -t "$SESS" "$@"; perl -e 'select(undef,undef,undef,0.5)'; }

"$TMUX" kill-session -t "$SESS" 2>/dev/null
"$TMUX" new-session -d -s "$SESS" -x 150 -y 34 "cd $ROOT && exec bun run src/cli.ts 2>/tmp/$SESS.err"

wait_for "ccmux .*· fleet" 30 || { echo "FAIL: TUI never rendered"; cat "/tmp/$SESS.err"; "$TMUX" kill-session -t "$SESS" 2>/dev/null; exit 1; }
wait_for "cc-" 30 # let the poll load real sessions (best-effort)
frame "initial (inline)"
key Down;  frame "after ↓"
key f;     frame "after f (fullscreen)"
key f;     frame "after f (back to inline)"
key q
"$TMUX" kill-session -t "$SESS" 2>/dev/null
echo "smoke done"
