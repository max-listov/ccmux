import { basename } from "node:path";
import type { ListRow } from "../commands/list.ts";
import type { DiscoveredSession } from "./discover.ts";
import { fmtAge, fmtTokens } from "./format.ts";
import { deriveStatus } from "./status.ts";
import type { AgentStatus } from "./status.ts";

// One navigable list = managed sessions (ours) + discovered external live sessions.
// Each item carries a unified agent status (thinking/editing/waiting/…) so managed and
// external read identically.

export interface FleetItem {
  row: ListRow;
  external: boolean;
  ext: DiscoveredSession | null;
  status: AgentStatus;
  /** "5m ago" — when the conversation last moved. Precomputed here (not in the card) so
   *  SessionCard's memo compares a primitive and re-renders only when the label changes. */
  activityText: string | null;
}

// EXTERNAL sessions have no tmux pane to scrape, so "did the transcript move recently" is the
// only liveness signal we have for them. 30s tolerates the quiet stretches mid-turn (tool runs,
// long generations write nothing until they finish). Managed sessions DON'T use this — their
// pane spinner is the authoritative, precise signal (see pane.ts WORKING_RE); folding jsonl
// freshness into managed only added a 30s false-"working" tail after every finished turn.
const RECENT_ACTIVITY_MS = 30_000;

/** Present a discovered external session as a (read-only) ListRow for the shared renderer. */
export function externalToRow(ext: DiscoveredSession): ListRow {
  const tokens = ext.usedTokens && ext.usedTokens > 0 ? fmtTokens(ext.usedTokens) : "-";
  return {
    session: {
      name: `${basename(ext.dir) || "claude"}·${ext.uuid.slice(0, 6)}`,
      dir: ext.dir,
      uuid: ext.uuid,
      flags: [],
      archived: false,
      resumeText: "continue",
      agent: "claude",
      chatEnabled: false,
    },
    running: true, // an external session in the list is a LIVE one (recent activity)
    state: "external",
    model: ext.model ? ext.model.replace(/^claude-/, "") : null,
    contextLabel: tokens,
    context: { text: tokens === "-" ? null : tokens, usedTokens: ext.usedTokens, limitTokens: null, percent: null },
    uptimeText: "—", // no tmux pane → no uptime; the activity age is the item's activityText
    uptimeSeconds: null,
    createdAt: null,
    lastMessage: ext.lastMessage,
    lastActivityMs: ext.lastActivityMs,
  };
}

const recentlyActive = (ms: number | null): boolean => ms !== null && Date.now() - ms < RECENT_ACTIVITY_MS;

// ── list order: most recently active conversation first ────────────────────────────────
// Sorting by RAW mtime made cards swap places on every poll tick while several agents were
// writing — unusable nav (that's why activity sort was once ripped out of discover). Two
// stabilizers fix the root: (1) the sort key is MINUTE-bucketed, so an actively-writing pair
// reorders at most once a minute; (2) ties keep a deterministic name order. A session with no
// transcript yet sorts by its tmux start time (just created = active now), else to the bottom.
const ACTIVITY_BUCKET_MS = 60_000;

function activityBucket(row: ListRow): number {
  const ms = row.lastActivityMs ?? (row.createdAt ? Date.parse(row.createdAt) : null);
  return ms === null || Number.isNaN(ms) ? -1 : Math.floor(ms / ACTIVITY_BUCKET_MS);
}

function byActivity(a: FleetItem, b: FleetItem): number {
  return activityBucket(b.row) - activityBucket(a.row) || a.row.session.name.localeCompare(b.row.session.name);
}

export function buildItems(managed: ListRow[], discovered: DiscoveredSession[]): { items: FleetItem[]; externalStart: number } {
  const m = managed.map((row): FleetItem => ({
    row,
    external: false,
    ext: null,
    // pane scan is the primary "working" signal; the transcript-moved fallback catches the
    // frames the regex misses AND adopted sessions whose pane is a parallel idle resume.
    status: deriveStatus({ running: row.running, isWorking: row.state === "working" || recentlyActive(row.lastActivityMs), lastMessage: row.lastMessage }),
    activityText: row.lastActivityMs !== null ? fmtAge(row.lastActivityMs) : null,
  }));
  const e = discovered.map((ext): FleetItem => ({
    row: externalToRow(ext),
    external: true,
    ext,
    status: deriveStatus({
      running: true,
      isWorking: recentlyActive(ext.lastActivityMs),
      lastMessage: ext.lastMessage,
    }),
    activityText: fmtAge(ext.lastActivityMs),
  }));
  // each section sorts within itself — managed stay above the external separator
  m.sort(byActivity);
  e.sort(byActivity);
  return { items: [...m, ...e], externalStart: m.length };
}
