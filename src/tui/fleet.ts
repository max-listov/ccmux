import { basename } from "node:path";
import type { ListRow } from "../commands/list.ts";
import type { DiscoveredSession } from "./discover.ts";
import { fmtTokens } from "./format.ts";
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
}

// EXTERNAL sessions have no tmux pane to scrape, so "did the transcript move recently" is the
// only liveness signal we have for them. 30s tolerates the quiet stretches mid-turn (tool runs,
// long generations write nothing until they finish). Managed sessions DON'T use this — their
// pane spinner is the authoritative, precise signal (see pane.ts WORKING_RE); folding jsonl
// freshness into managed only added a 30s false-"working" tail after every finished turn.
const RECENT_ACTIVITY_MS = 30_000;

function ageText(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

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
    },
    running: true, // an external session in the list is a LIVE one (recent activity)
    state: "external",
    model: ext.model ? ext.model.replace(/^claude-/, "") : null,
    contextLabel: tokens,
    context: { text: tokens === "-" ? null : tokens, usedTokens: ext.usedTokens, limitTokens: null, percent: null },
    uptimeText: ageText(ext.lastActivityMs),
    uptimeSeconds: null,
    createdAt: null,
    lastMessage: ext.lastMessage,
    lastActivityMs: ext.lastActivityMs,
  };
}

const recentlyActive = (ms: number | null): boolean => ms !== null && Date.now() - ms < RECENT_ACTIVITY_MS;

export function buildItems(managed: ListRow[], discovered: DiscoveredSession[]): { items: FleetItem[]; externalStart: number } {
  const m = managed.map((row): FleetItem => ({
    row,
    external: false,
    ext: null,
    // pane scan is the primary "working" signal; the transcript-moved fallback catches the
    // frames the regex misses AND adopted sessions whose pane is a parallel idle resume.
    status: deriveStatus({ running: row.running, isWorking: row.state === "working" || recentlyActive(row.lastActivityMs), lastMessage: row.lastMessage }),
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
  }));
  return { items: [...m, ...e], externalStart: managed.length };
}
