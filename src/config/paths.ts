import { basename, join } from "node:path";
import { HOME, IS_DEV, SELF_ARGV } from "../env.ts";
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
 *   <data>/ccmux/     app/                              the running code; deleting it is not
 *                                                       recoverable BY this tool
 *   <cache>/ccmux/    staged/, releases/                one update command rebuilds it
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

/** Durable: the code itself. The bundle used to live in the cache root under the reasoning that
 *  losing it "costs exactly one `ccmux update`". That reasoning was wrong in a way only an incident
 *  makes obvious: `ccmux update` IS the deleted file, and the boot unit's ExecStart points at it too,
 *  so a wiped cache left a machine whose CLI could not run and whose daemon could not be restarted —
 *  alive only as an already-loaded process. A directory whose contract invites deletion must not hold
 *  the one artifact that deletion makes unrecoverable. */
export const DATA_DIR: string =
  process.env.CCMUX_DATA_DIR ?? join(xdgRoot(process.env.XDG_DATA_HOME, join(HOME, ".local", "share")), "ccmux");

/** Disposable: a locally staged build and downloaded releases. Both are re-derivable WITHOUT the
 *  tool being intact — a stage command or a fresh download — so deleting them really does cost
 *  nothing but time. */
export const CACHE_DIR: string =
  process.env.CCMUX_CACHE_DIR ?? join(xdgRoot(process.env.XDG_CACHE_HOME, join(HOME, ".cache")), "ccmux");

// ── data: the artifact ───────────────────────────────────────────────────────────────────────────

/** The bundle the boot daemon and the `ccmux` command run; `ccmux update` swaps it atomically. */
export const APP_BUNDLE = join(DATA_DIR, "app", "ccmux.js");
/** Where installs before the durable-root move put the bundle. Read only by the migration. */
export const LEGACY_APP_BUNDLE = join(CACHE_DIR, "app", "ccmux.js");

// ── cache: what a download or a build can rebuild ────────────────────────────────────────────────
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
// Chat changed generation in a deliberate clean cutover: records from before it carry no provider or
// thread, and guessing those into them would corrupt routing. What the generation must NOT do is
// leak into a file NAME — `chat-v2.jsonl` becomes a lie the moment there is a 3, and it parks a dead
// archive beside live state under a near-identical name, which is exactly the "is this junk?"
// question this layout exists to end. So the live files keep canonical names forever, the record
// carries its own generation (see CHAT_GENERATION), and superseded state moves under `archive/`,
// where the PATH says it is not live.
// The registry keeps its canonical path too: strict parsing now requires every row to carry
// agent+UUID, so an implicit older row fails loudly instead of making the fleet disappear on upgrade.
export const sessionsPath = (m: MachineConfig): string => join(m.stateDir, "sessions.jsonl");
export const pendingSessionsPath = (m: MachineConfig): string => join(m.stateDir, "pending-sessions.json");
export const sessionRegistryLockPath = (m: MachineConfig): string => join(m.stateDir, "sessions.lock");
export const lifecycleBlockPath = (m: MachineConfig, name: string): string => join(m.stateDir, "lifecycle-blocks", `${name}.json`);
export const chatLedgerPath = (m: MachineConfig): string => join(m.stateDir, "chat.jsonl");
export const chatCursorsPath = (m: MachineConfig): string => join(m.stateDir, "chat-cursors.json");
export const chatAckPath = (m: MachineConfig): string => join(m.stateDir, "chat-ack.jsonl");
export const outboxPath = (m: MachineConfig): string => join(m.stateDir, "outbox.jsonl");
export const outboxAckPath = (m: MachineConfig): string => join(m.stateDir, "outbox-ack.jsonl");
/** The session event feed — what HAPPENED, as opposed to what IS. Rotated like the log, because it
 *  is a stream with no natural end, and read by outside surfaces that must not have to know the
 *  file layout (that is what `ccmux events` is for). */
export const eventsPath = (m: MachineConfig): string => join(m.stateDir, "events.jsonl");
/** Superseded state, kept readable but out of the way. One directory, so "what here is dead?" is
 *  answered by the path instead of by remembering which name came first. */
export const archiveDir = (m: MachineConfig): string => join(m.stateDir, "archive");

export const chatAuthPath = (m: MachineConfig, sessionName: string): string => join(m.stateDir, "chat-auth", sessionName);

// ── how this tool re-execs itself ────────────────────────────────────────────────────────────────

/**
 * The argv a boot unit or a PATH shim should be written with — the invocation this tool WANTS to be
 * launched by, which is not always the one it happens to be running under. During the move to a
 * durable root a process is launched from the legacy cache path and must still write the new one,
 * so deriving the launch line from `process.execPath` alone would faithfully re-record the path we
 * are trying to leave. A source checkout keeps re-execing its source.
 */
export function bootArgv(): readonly string[] {
  if (IS_DEV) return SELF_ARGV;
  const exec = process.execPath;
  // A compiled single-file binary IS the thing to launch; under bun, the bundle is.
  return basename(exec).toLowerCase() === "bun" ? [exec, APP_BUNDLE] : [exec];
}
