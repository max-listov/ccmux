import { join } from "node:path";
import { HOME } from "../env.ts";
import type { MachineConfig } from "../types.ts";

/**
 * Where ccmux keeps everything — ONE module that knows the whole layout.
 *
 * Split by LIFETIME, not by topic, because the question people actually ask is "can I delete this?"
 * and the path should answer it by itself:
 *
 *   <config>/ccmux/   machine.json                      a human edits this
 *   <state>/ccmux/    sessions.jsonl, chat*, outbox*,   losing it costs real work
 *                     status/, ccmux.log, boot-attempts
 *   <cache>/ccmux/    app/, staged/, releases/          one update command rebuilds it
 *
 * This replaces a layout where half the state sat as bare dotfiles in the home directory while the
 * rest lived under a private directory — and where the location was decided by a REQUIRED config
 * field holding a FILE path. That made drift structural: every machine answered the question
 * separately, and one careless path dragged five unrelated files along with it, because their
 * directory was derived from that file's. Nothing is configured per machine now — the roots are
 * derived, so a fresh machine lands correctly without anyone deciding anything.
 */

/** An XDG root, or the platform default when the variable is unset or not absolute. */
function xdgRoot(envValue: string | undefined, fallback: string): string {
  return envValue !== undefined && envValue.startsWith("/") ? envValue : fallback;
}

/** Durable: the registry, the chat ledger and its cursors, the outbox, per-session status, the log.
 *  `CCMUX_STATE_DIR` is the single knob an isolated instance flips to get its own. */
export const STATE_DIR: string =
  process.env.CCMUX_STATE_DIR ?? join(xdgRoot(process.env.XDG_STATE_HOME, join(HOME, ".local", "state")), "ccmux");

/** Disposable: the running bundle, a locally staged build, downloaded releases. Deleting this costs
 *  exactly one `ccmux update` — which is precisely why it must not share a directory with the registry. */
export const CACHE_DIR: string =
  process.env.CCMUX_CACHE_DIR ?? join(xdgRoot(process.env.XDG_CACHE_HOME, join(HOME, ".cache")), "ccmux");

// ── cache: the artifact ──────────────────────────────────────────────────────────────────────────

/** The bundle the boot daemon and the `ccmux` command run; `ccmux update` swaps it atomically. */
export const APP_BUNDLE = join(CACHE_DIR, "app", "ccmux.js");
/** A local dev build; `ccmux update` prefers it over a remote release ("test before publishing"). */
export const STAGED_BUNDLE = join(CACHE_DIR, "staged", "ccmux.js");
/** A published release (bundle + manifest) the daemon pulls from the configured release URL. */
export const RELEASES_DIR = join(CACHE_DIR, "releases");
export const RELEASE_BUNDLE = join(RELEASES_DIR, "ccmux.js");
export const RELEASE_MANIFEST = join(RELEASES_DIR, "release.json");

// ── state: what must survive ─────────────────────────────────────────────────────────────────────

/** Boot-loop guard counter (see util/bootGuard.ts) — daemon start attempts since the last good pass. */
export const BOOT_ATTEMPTS = join(STATE_DIR, "boot-attempts");
/** Per-session structured status (agent hooks + statusLine tee): lifecycle, metrics, chat holds and
 *  launch stamps — so `list`/TUI read authoritative state instead of scraping the pane. */
export const STATUS_DIR = join(STATE_DIR, "status");
export const LOG_FILE = join(STATE_DIR, "ccmux.log");

/**
 * The state files a given MachineConfig points at.
 *
 * They take the directory from the config rather than from the module constant so a test — or an
 * instance constructed in-process — gets its own set by building one config object, without
 * touching process-wide environment. `stateDir` is always filled in by the loader.
 */
// Chat v2 is a deliberate clean cutover. The unversioned chat files remain untouched as a read-only
// archive; guessing provider/thread identity into their name-only records would corrupt routing.
// The registry keeps its canonical path: strict parsing now requires every row to carry agent+UUID,
// so an implicit legacy row fails loudly instead of making the managed fleet disappear on upgrade.
export const sessionsPath = (m: MachineConfig): string => join(m.stateDir, "sessions.jsonl");
export const pendingSessionsPath = (m: MachineConfig): string => join(m.stateDir, "pending-sessions.json");
export const sessionRegistryLockPath = (m: MachineConfig): string => join(m.stateDir, "sessions.lock");
export const lifecycleBlockPath = (m: MachineConfig, name: string): string => join(m.stateDir, "lifecycle-blocks", `${name}.json`);
export const chatLedgerPath = (m: MachineConfig): string => join(m.stateDir, "chat-v2.jsonl");
export const chatCursorsPath = (m: MachineConfig): string => join(m.stateDir, "chat-cursors-v2.json");
export const chatAckPath = (m: MachineConfig): string => join(m.stateDir, "chat-ack-v2.jsonl");
export const outboxPath = (m: MachineConfig): string => join(m.stateDir, "outbox-v2.jsonl");
export const outboxAckPath = (m: MachineConfig): string => join(m.stateDir, "outbox-ack-v2.jsonl");
export const chatAuthPath = (m: MachineConfig, sessionName: string): string => join(m.stateDir, "chat-auth", sessionName);
