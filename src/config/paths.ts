import { HOME } from "../env.ts";

// Where the PROD artifact lives, separate from any dev checkout. The boot daemon and the
// `ccmux` command run APP_BUNDLE; `ccmux update` atomically swaps it. A local dev build
// lands in STAGED_BUNDLE and `ccmux update` prefers it over a remote release (the
// "test an update locally before publishing" flow).
export const CCMUX_HOME = `${HOME}/.ccmux`;
export const APP_BUNDLE = `${CCMUX_HOME}/app/ccmux.js`;
export const STAGED_BUNDLE = `${CCMUX_HOME}/staged/ccmux.js`;
// A published release (bundle + manifest) the daemon pulls via a file:// or http releaseUrl
// — local distribution without git/GitHub. Swap the URL for GitHub-raw later; code is identical.
export const RELEASES_DIR = `${CCMUX_HOME}/releases`;
export const RELEASE_BUNDLE = `${RELEASES_DIR}/ccmux.js`;
export const RELEASE_MANIFEST = `${RELEASES_DIR}/release.json`;
// Boot-loop guard counter (see util/bootGuard.ts) — daemon start attempts since last good pass.
export const BOOT_ATTEMPTS = `${CCMUX_HOME}/boot-attempts`;
