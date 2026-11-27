#!/usr/bin/env bash
# Build the stitchmux single-file binary, then (on macOS) sign it with a STABLE
# identity so each rebuild isn't seen as a brand-new app — that keeps macOS TCC /
# cloud-provider permission decisions sticky across rebuilds.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-$HOME/.local/bin/stitchmux}"
# Locate bun even when PATH is minimal (e.g. invoked from a non-login shell).
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
"$BUN" build src/cli.ts --compile --outfile "$OUT"

if [[ "$(uname)" == "Darwin" ]]; then
  # Prefer an explicit identity (STITCHMUX_SIGN_ID); else the first Apple Development one.
  SIGN_ID="${STITCHMUX_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -m1 'Apple Development' | sed -E 's/.*"(.*)".*/\1/')}"
  if [[ -n "${SIGN_ID:-}" ]]; then
    codesign --force --sign "$SIGN_ID" --identifier com.stitchmux.daemon "$OUT"
    echo "signed $OUT  (identity: $SIGN_ID)"
  else
    echo "no codesign identity found (set STITCHMUX_SIGN_ID) — left ad-hoc: $OUT"
  fi
fi
echo "built $OUT"
