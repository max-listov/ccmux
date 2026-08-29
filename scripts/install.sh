#!/usr/bin/env bash
# ccmux client bootstrap AND repair — one command, safe on any machine in any state:
#   curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | bash
#
# Converges this machine onto the current release: installs bun if missing, fetches the
# sha256-verified bundle, writes the `ccmux` PATH shim, and registers the boot unit. Every step
# writes only what actually differs, so on a healthy machine this changes nothing and restarts
# nothing — which is what makes it usable as the repair command, not just the install command.
#
# IDENTITY IS READ, NEVER RE-DECLARED. A machine that already has machine.json keeps its rcPrefix;
# CCMUX_RC_PREFIX applies only to a machine that has no config yet. Re-declaring it would rename the
# machine in Remote Control and break every session's continuity — which is precisely why this
# script could not previously be used to fix a broken install.
#
# Override the source repo with CCMUX_REPO=owner/name (default below is the upstream repo).
set -euo pipefail

REPO="${CCMUX_REPO:-max-listov/ccmux}"
BASE="https://github.com/${REPO}/releases/latest/download"
MANIFEST_URL="${BASE}/release.json"
BUNDLE_URL="${BASE}/ccmux.js"

CONFIG="${CCMUX_CONFIG:-${HOME}/.config/ccmux/machine.json}"
# The code lives in the DURABLE root: a cache is a directory whose contract invites deletion, and
# deleting the tool takes its own recovery path with it (the boot unit and this shim both point here).
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ccmux"
APP_DIR="${DATA_DIR}/app"
LEGACY_APP="${XDG_CACHE_HOME:-$HOME/.cache}/ccmux/app/ccmux.js"
BIN_DIR="${HOME}/.local/bin"
SHIM="${BIN_DIR}/ccmux"

say()  { printf '\033[36mccmux-install:\033[0m %s\n' "$1"; }
warn() { printf '\033[33mccmux-install:\033[0m %s\n' "$1"; }
die()  { printf '\033[31mccmux-install: %s\033[0m\n' "$1" >&2; exit 1; }

# Read one top-level string field out of machine.json without assuming jq is present.
json_field() { # $1=file $2=key
  [ -f "$1" ] || return 0
  grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$1" | head -1 | sed -E "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/"
}

CHANGED=0
note_change() { CHANGED=1; say "$1"; }

# ── identity: discovered, not assigned ───────────────────────────────────────
EXISTING_PREFIX="$(json_field "$CONFIG" rcPrefix || true)"
if [ -n "$EXISTING_PREFIX" ]; then
  RC_PREFIX="$EXISTING_PREFIX"
  if [ -n "${CCMUX_RC_PREFIX:-}" ] && [ "${CCMUX_RC_PREFIX}" != "$EXISTING_PREFIX" ]; then
    die "this machine is already '${EXISTING_PREFIX}' (${CONFIG}); refusing to rename it to '${CCMUX_RC_PREFIX}'. Renaming changes every session's Remote Control name — edit machine.json deliberately if that is what you want."
  fi
  say "identity: ${RC_PREFIX} (from ${CONFIG})"
else
  RC_PREFIX="${CCMUX_RC_PREFIX:-local}"
  say "identity: ${RC_PREFIX} (new machine)"
fi

# ── bun ──────────────────────────────────────────────────────────────────────
BUN="$(command -v bun || true)"
if [ -z "$BUN" ] && [ -x "${HOME}/.bun/bin/bun" ]; then BUN="${HOME}/.bun/bin/bun"; fi
if [ -z "$BUN" ]; then
  say "bun not found — installing…"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || die "bun install failed"
  BUN="${HOME}/.bun/bin/bun"
  [ -x "$BUN" ] || die "bun installed but not at ${BUN}"
  note_change "bun installed"
fi
say "bun: ${BUN}"

# ── manifest ─────────────────────────────────────────────────────────────────
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
say "fetching manifest…"
curl -fsSL "$MANIFEST_URL" -o "${TMP}/release.json" || die "cannot fetch ${MANIFEST_URL} (is the repo public, a release published?)"
VERSION="$(json_field "${TMP}/release.json" version)"
WANT_SHA="$(json_field "${TMP}/release.json" sha256)"
[ -n "$WANT_SHA" ] || die "manifest has no sha256"
say "latest version: ${VERSION:-?}"

sha_of() { # $1=file → sha256 or empty
  [ -f "$1" ] || return 0
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# ── bundle: fetch only when what is on disk is not already the wanted bytes ──
HAVE_SHA="$(sha_of "${APP_DIR}/ccmux.js" || true)"
if [ "$HAVE_SHA" = "$WANT_SHA" ]; then
  say "bundle: already ${VERSION} (unchanged)"
else
  say "downloading bundle…"
  curl -fsSL "$BUNDLE_URL" -o "${TMP}/ccmux.js" || die "cannot fetch ${BUNDLE_URL}"
  GOT="$(sha_of "${TMP}/ccmux.js")"
  [ "$GOT" = "$WANT_SHA" ] || die "checksum mismatch — expected ${WANT_SHA}, got ${GOT}. ABORTED"
  mkdir -p "$APP_DIR"
  mv "${TMP}/ccmux.js" "${APP_DIR}/ccmux.js"
  note_change "bundle installed: ${APP_DIR}/ccmux.js (sha256 verified)"
fi

# A bundle left in the old cache location is a second, stale copy of the tool; the boot unit is
# rewritten below to stop pointing at it.
if [ -f "$LEGACY_APP" ]; then
  rm -f "$LEGACY_APP" "${LEGACY_APP}.bak"
  note_change "removed the stale bundle from the cache root"
fi

# ── shim ─────────────────────────────────────────────────────────────────────
WANT_SHIM="$(printf '#!/bin/sh\nexec "%s" "%s/ccmux.js" "$@"\n' "$BUN" "$APP_DIR")"
if [ -f "$SHIM" ] && [ "$(cat "$SHIM")" = "$WANT_SHIM" ]; then
  say "shim: already correct (unchanged)"
else
  mkdir -p "$BIN_DIR"
  NEXT_SHIM="${TMP}/ccmux"
  printf '%s' "$WANT_SHIM" > "$NEXT_SHIM"
  chmod +x "$NEXT_SHIM"
  mv "$NEXT_SHIM" "$SHIM"
  note_change "shim written: ${SHIM}"
fi
case ":${PATH}:" in *":${BIN_DIR}:"*) ;; *) warn "add ${BIN_DIR} to PATH (not currently on it)";; esac

# ── boot unit: register when absent, or when it launches the wrong path ──────
BOOT_LABEL="$(json_field "$CONFIG" bootLabel || true)"
UNIT_OK=0
if [ -n "$BOOT_LABEL" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then UNIT="${HOME}/Library/LaunchAgents/${BOOT_LABEL}.plist"
  else UNIT="/etc/systemd/system/${BOOT_LABEL}"; fi
  # Correct means: the unit exists AND launches the bundle we just converged on.
  if [ -f "$UNIT" ] && grep -q "${APP_DIR}/ccmux.js" "$UNIT" 2>/dev/null; then UNIT_OK=1; fi
fi
if [ "$UNIT_OK" = "1" ]; then
  say "boot unit: already launches ${APP_DIR}/ccmux.js (unchanged)"
else
  say "registering boot unit (rc-prefix=${RC_PREFIX})…"
  "$SHIM" install --rc-prefix "$RC_PREFIX" --release-url "$MANIFEST_URL"
  note_change "boot unit registered"
fi

if [ "$CHANGED" = "0" ]; then
  say "nothing to do — this machine was already correct. Nothing was written, nothing restarted."
else
  say "done. 'ccmux list' to see the fleet; the daemon self-updates from latest."
fi
