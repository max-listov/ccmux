#!/usr/bin/env bash
# ccmux client bootstrap — one command to a running, self-updating daemon:
#   curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | bash
#
# Installs bun if missing, downloads the latest release bundle (sha256-verified against the
# manifest), drops a `ccmux` shim on PATH, and runs `ccmux install` with autoUpdate wired to
# the latest-release manifest. Idempotent — safe to re-run (it just refreshes to latest).
#
# Override the source repo with CCMUX_REPO=owner/name (default below is the upstream repo).
set -euo pipefail

REPO="${CCMUX_REPO:-max-listov/ccmux}"
RC_PREFIX="${CCMUX_RC_PREFIX:-local}"
BASE="https://github.com/${REPO}/releases/latest/download"
MANIFEST_URL="${BASE}/release.json"
BUNDLE_URL="${BASE}/ccmux.js"

CCMUX_HOME="${HOME}/.ccmux"
APP_DIR="${CCMUX_HOME}/app"
BIN_DIR="${HOME}/.local/bin"
SHIM="${BIN_DIR}/ccmux"

say() { printf '\033[36mccmux-install:\033[0m %s\n' "$1"; }
die() { printf '\033[31mccmux-install: %s\033[0m\n' "$1" >&2; exit 1; }

# ── bun ──────────────────────────────────────────────────────────────────────
BUN="$(command -v bun || true)"
if [ -z "$BUN" ] && [ -x "${HOME}/.bun/bin/bun" ]; then BUN="${HOME}/.bun/bin/bun"; fi
if [ -z "$BUN" ]; then
  say "bun not found — installing…"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || die "bun install failed"
  BUN="${HOME}/.bun/bin/bun"
  [ -x "$BUN" ] || die "bun installed but not at ${BUN}"
fi
say "bun: ${BUN}"

# ── download + verify bundle ─────────────────────────────────────────────────
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
say "fetching manifest…"
curl -fsSL "$MANIFEST_URL" -o "${TMP}/release.json" || die "cannot fetch ${MANIFEST_URL} (is the repo public, a release published?)"
VERSION="$(grep -o '"version"[^,]*' "${TMP}/release.json" | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
WANT_SHA="$(grep -o '"sha256"[^,]*' "${TMP}/release.json" | head -1 | sed -E 's/.*"sha256"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
[ -n "$WANT_SHA" ] || die "manifest has no sha256"
say "latest version: ${VERSION:-?}"

say "downloading bundle…"
curl -fsSL "$BUNDLE_URL" -o "${TMP}/ccmux.js" || die "cannot fetch ${BUNDLE_URL}"
if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "${TMP}/ccmux.js" | cut -d' ' -f1)"
else GOT="$(shasum -a 256 "${TMP}/ccmux.js" | cut -d' ' -f1)"; fi
[ "$GOT" = "$WANT_SHA" ] || die "checksum mismatch — expected ${WANT_SHA}, got ${GOT}. ABORTED"
say "sha256 verified"

# ── install bundle + shim ────────────────────────────────────────────────────
mkdir -p "$APP_DIR" "$BIN_DIR"
mv "${TMP}/ccmux.js" "${APP_DIR}/ccmux.js"
cat > "$SHIM" <<EOF
#!/usr/bin/env bash
exec "${BUN}" "${APP_DIR}/ccmux.js" "\$@"
EOF
chmod +x "$SHIM"
say "shim: ${SHIM}"
case ":${PATH}:" in *":${BIN_DIR}:"*) ;; *) say "NOTE: add ${BIN_DIR} to PATH (not currently on it)";; esac

# ── boot unit + autoUpdate wired to latest ───────────────────────────────────
say "installing boot unit (rc-prefix=${RC_PREFIX})…"
"$SHIM" install --rc-prefix "$RC_PREFIX" --release-url "$MANIFEST_URL"
say "done. 'ccmux list' to see the fleet; the daemon self-updates from latest."
