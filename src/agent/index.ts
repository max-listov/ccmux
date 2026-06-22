import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { AgentKind, ContextInfo, MachineConfig, Session, TranscriptMessage } from "../types.ts";
import { claudeProvider } from "./claude/index.ts";
import { codexProvider } from "./codex/index.ts";
import { rec, str } from "./normalize.ts";
import { MtimeCache } from "../util/mtimeCache.ts";

/** Live status scraped from a rendered pane (pure: text → status). */
export interface PaneScan {
  model: string | null;
  state: "working" | "idle";
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
  // launch
  buildArgv(s: Session, m: MachineConfig, selfDisplay: string, historyPresent: boolean): string[];
  launchEnv(m: MachineConfig, sessionName: string): Record<string, string>;
  // history / resume
  historyFile(s: Session, m: MachineConfig): string | null;
  // transcript (raw JSONL → shared contract)
  parse(lines: string[], startLine: number, textLimit?: number): TranscriptMessage[];
  usedTokens(lines: string[]): number | null;
  // live pane status
  scanPane(paneText: string): PaneScan;
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

/** Best-effort format sniff from the first non-empty line — fallback for legacy rows. */
export function detect(lines: string[]): AgentKind | null {
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    let entry: Record<string, unknown> | null = null;
    try {
      entry = rec(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) continue;
    const type = str(entry.type);
    if (type === "response_item" || type === "session_meta" || type === "event_msg") return "codex";
    if (entry.message !== undefined || entry.sessionId !== undefined) return "claude";
    return null;
  }
  return null;
}

// ── IO + windowing (shared; adapters stay pure transforms) ───────────────────

const LAST_MESSAGE_WINDOW = 120;
const LAST_MESSAGE_TEXT_LIMIT = 280;

function readLines(path: string): string[] {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const TAIL_CHUNK = 512 * 1024;

/** Read just the last `maxLines` lines — transcripts grow to tens of MB and the hot
 *  paths (list row, TUI pane, CTX fallback) only ever parse a tail window, so reading
 *  the whole file each poll tick was the dominant I/O cost of the entire app.
 *  Pulls 512KB slices from the file end until enough newlines are seen; newline
 *  counting is byte-level (0x0A never occurs inside a UTF-8 multi-byte char) and
 *  decoding happens once over the joined buffer, so slice borders can't split chars.
 *  Absolute line NUMBERS are lost — the `transcript --cursor` contract keeps going
 *  through readLines (exact, full read). */
export function readTailLines(path: string, maxLines: number): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size <= TAIL_CHUNK) {
    const lines = readLines(path);
    return lines.length > maxLines ? lines.slice(-maxLines) : lines;
  }
  const fd = openSync(path, "r");
  const slices: Buffer[] = [];
  try {
    let start = size;
    let newlines = 0;
    // maxLines+1 newlines: the first line of a mid-file window is dropped as possibly partial.
    while (start > 0 && newlines <= maxLines) {
      const from = Math.max(0, start - TAIL_CHUNK);
      const buf = Buffer.alloc(start - from);
      readSync(fd, buf, 0, buf.length, from);
      slices.unshift(buf);
      start = from;
      for (const byte of buf) if (byte === 10) newlines++;
    }
    const lines = Buffer.concat(slices).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.length > maxLines ? lines.slice(-maxLines) : lines;
  } finally {
    closeSync(fd);
  }
}

export interface TranscriptRead {
  agent: AgentKind;
  available: boolean;
  error: string | null;
  path: string;
  totalLines: number;
  messages: TranscriptMessage[];
  mtimeMs: number | null;
}

/** Read + normalize a transcript with tail / cursor windowing. */
export function readTranscript(
  session: Session,
  m: MachineConfig,
  opts: { tail: number; cursor?: number },
): TranscriptRead {
  const provider = providerFor(session);
  const path = provider.historyFile(session, m);
  if (!path || !existsSync(path)) {
    return { agent: provider.id, available: false, error: "transcript file not found", path: path ?? "", totalLines: 0, messages: [], mtimeMs: null };
  }
  const lines = readLines(path);
  const total = lines.length;
  const start =
    opts.cursor !== undefined && Number.isFinite(opts.cursor)
      ? opts.cursor + 1
      : total > opts.tail
        ? total - opts.tail + 1
        : 1;
  const messages = provider.parse(lines, Math.max(1, start));
  let mtimeMs: number | null = null;
  try {
    mtimeMs = Math.floor(statSync(path).mtimeMs);
  } catch {
    mtimeMs = null;
  }
  return { agent: provider.id, available: true, error: null, path, totalLines: total, messages, mtimeMs };
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
  return provider.parse(readTailLines(path, tail), 1);
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

/** Usage rides every assistant turn — a 2k-line tail always contains the latest one. */
const USED_TOKENS_WINDOW = 2000;

/** Context tokens used — agent-specific, for the `list` CTX fallback (no statusline). */
export function sessionUsedTokens(session: Session, m: MachineConfig): number | null {
  const provider = providerFor(session);
  const path = provider.historyFile(session, m);
  if (!path) return null;
  return usedTokensCache.get(path, () => provider.usedTokens(readTailLines(path, USED_TOKENS_WINDOW)));
}
