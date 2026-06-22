import { loadMachineConfig, rcName } from "../config/machine.ts";
import { loadSessions } from "../config/sessions.ts";
import { listSessionsCreated } from "../tmux/tmux.ts";
import { humanizeDuration } from "../util/duration.ts";
import { capturePane } from "../tmux/tmux.ts";
import { providerFor, sessionUsedTokens, lastTranscriptMessage, lastActivityMs } from "../agent/index.ts";
import type { PaneScan } from "../agent/index.ts";
import { VERSION } from "../util/version.ts";
import { fmtTokens } from "../tui/format.ts";
import type { ContextInfo, ListItem, ListJson, MachineConfig, Session, SessionState, TranscriptMessage } from "../types.ts";

// Last pane scan per session — lets the TUI skip the `tmux capture-pane` FORK for cards that
// aren't visible (off-screen state is invisible anyway; it refreshes the moment it scrolls in).
// Keyed by session name; cleared when a session stops so a restart always re-captures.
const scanCache = new Map<string, PaneScan>();

/** One session's resolved status — the single data shape consumed by both the CLI
 *  (`cmdList`) and the live TUI. */
export interface ListRow {
  session: Session;
  running: boolean;
  state: SessionState;
  model: string | null;
  contextLabel: string; // human CTX column
  context: ContextInfo; // structured, for --json
  uptimeText: string;
  uptimeSeconds: number | null;
  createdAt: string | null;
  lastMessage: TranscriptMessage | null;
  lastActivityMs: number | null; // transcript file mtime — "conversation moved" (any instance)
}

/** Build one row. For a running session: scrape the pane; if it surfaces no context,
 *  fall back to the USED size from the transcript (size is known with or without a
 *  statusline). For a stopped session: everything blank. Mirrors bash `cmd_list`. */
async function buildRow(
  m: MachineConfig,
  s: Session,
  startedAt: number | undefined,
  nowSec: number,
  shouldCapture: boolean,
): Promise<ListRow> {
  const lastMessage = lastTranscriptMessage(s, m); // works running or stopped
  const activity = lastActivityMs(s, m);
  if (startedAt === undefined) {
    scanCache.delete(s.name); // stopped → drop stale scan so a restart re-captures
    return {
      session: s,
      running: false,
      state: "stopped",
      model: null,
      contextLabel: "-",
      context: { text: null, usedTokens: null, limitTokens: null, percent: null },
      uptimeText: "—",
      uptimeSeconds: null,
      createdAt: null,
      lastMessage,
      lastActivityMs: activity,
    };
  }
  const provider = providerFor(s);
  // Capture the live pane only when this card is visible (or has no scan yet); otherwise reuse the
  // last scan — one fewer fork per off-screen running session, every poll.
  const cached = scanCache.get(s.name);
  let scan: PaneScan;
  if (shouldCapture || !cached) {
    scan = provider.scanPane(await capturePane(m, s.name, 30));
    scanCache.set(s.name, scan);
  } else {
    scan = cached;
  }
  let context = scan.context;
  let contextLabel = scan.contextLabel;
  if (context.text === null) {
    const used = sessionUsedTokens(s, m);
    if (used !== null && used > 0) {
      contextLabel = fmtTokens(used);
      context = { text: contextLabel, usedTokens: used, limitTokens: null, percent: null };
    }
  }
  const uptimeSeconds = Math.floor(nowSec - startedAt);
  return {
    session: s,
    running: true,
    state: scan.state,
    model: scan.model,
    contextLabel,
    context,
    uptimeText: humanizeDuration(uptimeSeconds),
    uptimeSeconds,
    createdAt: new Date(startedAt * 1000).toISOString(),
    lastMessage,
    lastActivityMs: activity,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Archived (parked) sessions show "archived" in the human STATE column unless they're
 *  actually running — the run-state (working/idle) is the more truthful signal then. */
function stateLabel(r: ListRow): string {
  return r.session.archived && !r.running ? "archived" : r.state;
}

function printTable(m: MachineConfig, rows: ListRow[]): void {
  console.log(
    `${pad("SESSION", 14)} ${pad("MODEL", 9)} ${pad("CTX", 16)} ${pad("STATE", 8)} ${pad("UPTIME", 7)} ${pad("RC", 14)} DIR`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.session.name, 14)} ${pad(r.model ?? "-", 9)} ${pad(r.contextLabel, 16)} ${pad(stateLabel(r), 8)} ${pad(r.uptimeText, 7)} ${pad(rcName(m, r.session.name), 14)} ${r.session.dir}`,
    );
  }
}

function toListItem(m: MachineConfig, r: ListRow): ListItem {
  return {
    name: r.session.name,
    dir: r.session.dir,
    uuid: r.session.uuid,
    rc: rcName(m, r.session.name),
    running: r.running,
    archived: r.session.archived,
    state: r.state,
    model: r.model,
    context: r.context,
    uptime: { text: r.running ? r.uptimeText : null, seconds: r.uptimeSeconds },
    createdAt: r.createdAt,
    lastMessage: r.lastMessage,
  };
}

function printJson(m: MachineConfig, rows: ListRow[]): void {
  const out: ListJson = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    rcPrefix: m.rcPrefix,
    sessionsFile: m.sessionsFile,
    sessions: rows.map((r) => toListItem(m, r)),
  };
  console.log(JSON.stringify(out));
}

/** The single data source for both the CLI table/JSON and the live TUI. `liveNames` (TUI only) =
 *  the session names whose pane should be freshly captured this tick (visible + selected); others
 *  reuse their cached scan. Omit it (CLI `list`) to capture every running session, as before. */
export async function collectRows(m: MachineConfig, opts?: { liveNames?: Set<string> }): Promise<ListRow[]> {
  const created = await listSessionsCreated(m);
  const nowSec = Date.now() / 1000;
  const sessions = loadSessions(m);
  const liveNames = opts?.liveNames;
  return Promise.all(
    sessions.map((s) => buildRow(m, s, created.get(s.name), nowSec, liveNames === undefined || liveNames.has(s.name))),
  );
}

export async function cmdList(args: string[] = []): Promise<number> {
  const m = loadMachineConfig();
  const rows = await collectRows(m);
  if (args.includes("--json")) printJson(m, rows);
  else printTable(m, rows);
  return 0;
}
