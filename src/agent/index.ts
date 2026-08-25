import { existsSync, statSync } from "node:fs";
import type { AgentKind, ContextInfo, MachineConfig, Session, TranscriptMessage, TranscriptStats } from "../types.ts";
import { claudeProvider } from "./claude/index.ts";
import { codexProvider } from "./codex/index.ts";
import { rcName } from "../config/machine.ts";
import { MtimeCache } from "../util/mtimeCache.ts";
import { readLines, readTailLines, readTailUntil } from "../util/readLines.ts";
import type { LaunchInput } from "./launchInputs.ts";

// Format sniff lives in its own light module (normalize-only deps) so the public library seam can
// re-export it without pulling in the full providers; re-exported here to keep the existing name.
export { detect } from "./detect.ts";

/** Live status scraped from a rendered pane (pure: text → status). The MODEL is NOT here — it's
 *  conversation metadata read from jsonl (source of truth), not a live pane signal. */
export interface PaneScan {
  ready: boolean; // the agent's interactive UI is drawn (booted) — restart waitReady gates on this
  state: "working" | "idle";
  /** Short title of the blocking menu the pane is sitting at, else null. A session at a menu is not
   *  idle: it cannot act until a human (or the machine's policy) answers, and calling that state
   *  "idle" is how six sessions once came back from a restart dead while the fleet read healthy. */
  atPrompt: string | null;
  contextLabel: string; // human, "-" if none
  context: ContextInfo; // structured
}

/**
 * One agent CLI = one provider. It owns EVERYTHING agent-specific: how to launch
 * (`buildArgv`/`launchEnv`), where the conversation history lives (`historyFile`),
 * how to normalize that history (`parse`/`usedTokens`), and how to read the live pane
 * (`scanPane`). The core (run/list/lifecycle/TUI) only ever talks to this interface,
 * so a 3rd/4th agent is a new folder under src/agent/<id>/ — nothing in core changes.
 */
export interface AgentProvider {
  id: AgentKind;
  /** Deterministic configuration checks performed before any registry/tmux mutation. */
  preflight(m: MachineConfig): void;
  // launch — `cli` is how the injected prompt should tell the agent to invoke ccmux
  // (bare shim when installed, else absolute; see env.promptInvocation)
  buildArgv(s: Session, m: MachineConfig, cli: string, historyPresent: boolean): string[];
  /** The environment for the spawned agent. Takes the SESSION, not just its name, because the
   *  environment is a declared recipe (`envFile`) rather than whatever the supervisor happened to
   *  inherit — see agent/sessionEnv.ts for why that distinction had to become explicit. */
  launchEnv(m: MachineConfig, session: Session): Record<string, string>;
  /** The ccmux-controlled environment variable NAMES this launch injects — never their values.
   *  It exists so the launch stamp can see the one part of the recipe that is deliberately NOT in
   *  argv: a secret must not be an argument. Names are enough to answer "would relaunching give this
   *  session something it does not have", which is the only question the stamp asks. */
  launchEnvKeys(m: MachineConfig): readonly string[];
  /**
   * The EXTERNAL files this agent reads at startup and never re-reads — its global rule set, its MCP
   * configuration. They shape the session exactly as argv does, but they live outside it, so the
   * launch stamp could not see them: a fleet-wide rule change once left every session running
   * yesterday's rules behind a clean RESTART column.
   *
   * Provider-owned because the locations are agent-specific and the core must not learn them. The
   * core only asks "what did this launch read, and what is it now".
   */
  launchInputs(s: Session, m: MachineConfig): readonly LaunchInput[];
  // history / resume
  historyFile(s: Session, m: MachineConfig): string | null;
  /** The same conversation found somewhere OTHER than where this session expects it — used only
   *  when the expected file is missing, to tell "the history moved" apart from "first launch".
   *  Optional: an agent whose history location cannot drift does not implement it. */
  findHistoryElsewhere?(s: Session, m: MachineConfig): string | null;
  // Some agents (Claude) silently FORK a conversation to a new uuid (e.g. out-of-context
  // continuation) — this reports where the conversation lives NOW, or null if unmoved.
  // Optional: agents whose session ids are actually stable don't implement it.
  detectFork?(s: Session, m: MachineConfig, rcTitle: string, takenUuids: ReadonlySet<string>): string | null;
  // transcript (raw JSONL → shared contract). endLine bounds the upper edge of the window
  // for backward pagination; omit to parse through the end of the file.
  parse(lines: string[], startLine: number, textLimit?: number, endLine?: number): TranscriptMessage[];
  usedTokens(lines: string[]): number | null;
  // The conversation's CURRENT model, read from history (source of truth), or null if not yet
  // written / undetectable. Raw id (e.g. "claude-fable-5"); display formatting is prettyModel's job.
  lastModel(lines: string[]): string | null;
  // live pane status
  scanPane(paneText: string): PaneScan;
  // Claude 2.1.x shows a BLOCKING "Resume from summary?" picker on `--resume` of a large session;
  // an unattended resume strands there. Given the current pane text, return the keystroke that
  // dismisses it per the machine's resumePicker policy — the option NUMBER read from the pane, so
  // a reordered menu still gets the right key — or null when no picker is showing. Pure: text +
  // config → key. The supervisor polls this right after launch and sends the key (+Enter only if
  // the number key didn't already confirm). Optional: agents without such a picker omit it.
  promptAnswer?(paneText: string, m: MachineConfig): string | null;
  // Inter-agent chat: is it safe to inject a chat message into this pane RIGHT NOW? Pure: pane
  // text → bool. False when the session sits at a selection menu (injecting would pick an option
  // it never chose — proven live), so the daemon holds and retries. Optional: an agent with no
  // readiness detector is never delivered to (safe default). Used by src/chat/deliver.ts.
  chatDeliverable?(paneText: string): boolean;
  // Is the human's composer occupied right now (they typed a line and haven't sent it)? Injection
  // appends + hits Enter, so delivering then would send THEIR half-written text. Pure: pane → bool.
  // Optional: an agent without a detectable composer never reports busy (delivery proceeds).
  inputBusy?(paneText: string): boolean;
}

const REGISTRY: Record<AgentKind, AgentProvider> = {
  claude: claudeProvider,
  codex: codexProvider,
};

export function getProvider(agent: AgentKind): AgentProvider {
  return REGISTRY[agent];
}

export function providerFor(session: Session): AgentProvider {
  return REGISTRY[session.agent];
}

// ── IO + windowing (shared; adapters stay pure transforms) ───────────────────

const LAST_MESSAGE_WINDOW = 120;
const LAST_MESSAGE_TEXT_LIMIT = 280;

const EMPTY_STATS: TranscriptStats = { messages: 0, user: 0, assistant: 0, toolCalls: 0, thinking: 0 };
const statsCache = new MtimeCache<TranscriptStats>();

/** Whole-session composition, counted by re-parsing the full JSONL. Cached by mtime, so an idle
 *  session costs nothing and an active one recomputes only when it actually moves. */
function computeStats(provider: AgentProvider, lines: string[]): TranscriptStats {
  let user = 0;
  let assistant = 0;
  let toolCalls = 0;
  let thinking = 0;
  for (const msg of provider.parse(lines, 1)) {
    if (msg.kind === "tool_call") toolCalls++;
    else if (msg.kind === "thinking") thinking++;
    else if (msg.kind === "message") {
      if (msg.role === "user") user++;
      else if (msg.role === "assistant") assistant++;
    }
  }
  return { messages: user + assistant, user, assistant, toolCalls, thinking };
}

export interface TranscriptRead {
  agent: AgentKind;
  available: boolean;
  error: string | null;
  path: string;
  totalLines: number;
  messages: TranscriptMessage[];
  mtimeMs: number | null;
  // Window bounds for pagination: `firstLine` = absolute line the parse started at,
  // `reachedStart` = that window reaches the very first line (nothing older to load).
  firstLine: number;
  reachedStart: boolean;
  // Whole-session composition (all lines, cached by mtime) — true totals for the header.
  stats: TranscriptStats;
}

/**
 * Read + normalize a transcript window. Three modes:
 *   default        → last `tail` lines (fresh open).
 *   { cursor }     → forward: everything after line `cursor` (live tail growth).
 *   { before, limit } → backward: the `limit` lines ending just before line `before`
 *                       (infinite-scroll-up; line-based so it's robust to lines that
 *                       carry no message — blank / folded tool_result).
 */
export function readTranscript(
  session: Session,
  m: MachineConfig,
  opts: { tail: number; cursor?: number; before?: number; limit?: number; textLimit?: number },
): TranscriptRead {
  const provider = providerFor(session);
  const path = provider.historyFile(session, m);
  if (!path || !existsSync(path)) {
    return { agent: provider.id, available: false, error: "transcript file not found", path: path ?? "", totalLines: 0, messages: [], mtimeMs: null, firstLine: 1, reachedStart: true, stats: EMPTY_STATS };
  }
  const lines = readLines(path);
  const total = lines.length;
  let start: number;
  let endLine: number | undefined;
  if (opts.before !== undefined && Number.isFinite(opts.before)) {
    const limit = opts.limit !== undefined && Number.isFinite(opts.limit) ? opts.limit : opts.tail;
    endLine = opts.before - 1;
    start = opts.before - limit;
  } else if (opts.cursor !== undefined && Number.isFinite(opts.cursor)) {
    start = opts.cursor + 1;
  } else {
    start = total > opts.tail ? total - opts.tail + 1 : 1;
  }
  start = Math.max(1, start);
  const messages = provider.parse(lines, start, opts.textLimit, endLine);
  const stats = statsCache.get(path, () => computeStats(provider, lines)) ?? EMPTY_STATS;
  let mtimeMs: number | null = null;
  try {
    mtimeMs = Math.floor(statSync(path).mtimeMs);
  } catch {
    mtimeMs = null;
  }
  return { agent: provider.id, available: true, error: null, path, totalLines: total, messages, mtimeMs, firstLine: start, reachedStart: start <= 1, stats };
}

// mtime-keyed caches: skip the tail-read + JSON parse when the transcript hasn't moved, and (just
// as important) return a STABLE message reference so SessionCard's memo can bail out. An idle
// fleet thus does ZERO transcript reads/parses per poll — only a statSync per file.
const lastMsgCache = new MtimeCache<TranscriptMessage | null>();
const usedTokensCache = new MtimeCache<number | null>();

/** The single most-recent message — for `list --json` lastMessage ("where it stopped").
 *  Tail-read: seq is window-relative here (display value, not a cursor). */
export function lastTranscriptMessage(session: Session, m: MachineConfig): TranscriptMessage | null {
  const provider = providerFor(session);
  const path = provider.historyFile(session, m);
  if (!path) return null;
  return lastMsgCache.get(path, () => {
    const lines = readTailLines(path, LAST_MESSAGE_WINDOW);
    if (lines.length === 0) return null;
    const msgs = provider.parse(lines, 1, LAST_MESSAGE_TEXT_LIMIT);
    return msgs.length > 0 ? (msgs[msgs.length - 1] ?? null) : null;
  });
}

/** Tail window for live rendering (TUI transcript pane) — no absolute line numbers,
 *  cheap on big files. The exact/cursor contract stays on readTranscript. */
export function tailTranscript(session: Session, m: MachineConfig, tail: number): TranscriptMessage[] {
  const provider = providerFor(session);
  const path = provider.historyFile(session, m);
  if (!path || !existsSync(path)) return [];
  return provider.parse(readTailLines(path, tail, TRANSCRIPT_PANE_BYTES), 1);
}

/** When the transcript file was last written (epoch ms) — a "the conversation moved" signal
 *  that catches activity from ANY instance driving this uuid (e.g. an adopted session whose
 *  pane is a parallel idle resume). null if there's no transcript yet. */
export function lastActivityMs(session: Session, m: MachineConfig): number | null {
  const provider = providerFor(session);
  const path = provider.historyFile(session, m);
  if (!path || !existsSync(path)) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Usage rides every assistant turn, so the newest one is a few records back — the window is a
 *  ceiling for the pathological case, not the expected read. It is bounded in bytes too
 *  (readTailUntil), because a line cap alone bounds nothing on transcripts with huge records. */
const USED_TOKENS_WINDOW = 2000;

/** The transcript pane renders recent messages; this caps what one render may pull off disk. */
const TRANSCRIPT_PANE_BYTES = 4 * 1024 * 1024;

/** Context tokens used — agent-specific, for the `list` CTX fallback (no statusline). */
export function sessionUsedTokens(session: Session, m: MachineConfig): number | null {
  const provider = providerFor(session);
  const path = provider.historyFile(session, m);
  if (!path) return null;
  return usedTokensCache.get(path, () =>
    provider.usedTokens(readTailUntil(path, USED_TOKENS_WINDOW, (lines) => provider.usedTokens(lines) !== null)),
  );
}

// mtime-keyed like usedTokens: an idle session's model is read once per write, not per poll.
const modelCache = new MtimeCache<string | null>();

/** The session's current model as a RAW id (from jsonl, the source of truth) — the model banner
 *  no longer comes from the statusline whitelist, so a new family is never dropped. null when the
 *  history has no assistant turn yet. Format for display with prettyModel. */
export function sessionModel(session: Session, m: MachineConfig): string | null {
  const provider = providerFor(session);
  const path = provider.historyFile(session, m);
  if (!path) return null;
  return modelCache.get(path, () =>
    provider.lastModel(readTailUntil(path, USED_TOKENS_WINDOW, (lines) => provider.lastModel(lines) !== null)),
  );
}

/** Where the session's conversation lives NOW, if the agent forked it away from the
 *  pinned uuid (see AgentProvider.detectFork) — null when unmoved or not detectable.
 *  `all` = every managed session, so another session's pinned uuid is never claimed. */
export function forkedUuid(session: Session, m: MachineConfig, all: Session[]): string | null {
  const provider = providerFor(session);
  if (!provider.detectFork) return null;
  const taken = new Set(all.filter((x) => x.name !== session.name).map((x) => x.uuid));
  return provider.detectFork(session, m, rcName(m, session.name), taken);
}
