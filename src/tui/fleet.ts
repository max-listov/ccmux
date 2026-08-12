import { basename } from "node:path";
import { prettyModel } from "../agent/format.ts";
import type { ListRow } from "../commands/list.ts";
import { externalSessionKey, managedSessionKey } from "../external/keys.ts";
import type { DiscoveredSession } from "./discover.ts";
import { fmtAge, fmtTokens } from "./format.ts";
import { deriveStatus } from "./status.ts";
import type { AgentStatus } from "./status.ts";

export interface FleetItem {
  /** Stable UI identity. Metadata such as cwd, path, origin and activity never participates. */
  key: string;
  row: ListRow;
  external: boolean;
  ext: DiscoveredSession | null;
  status: AgentStatus;
  /** "5m ago" — precomputed so the memoized card compares a primitive. */
  activityText: string | null;
}

/** What the view knows about its own data, as opposed to what the data says. An empty list is
 *  not a fact until something has answered; the external section is absent by choice, not by
 *  emptiness. Both views read these through the helpers below so they cannot word it differently. */
export type FleetLoad = {
  /** The managed fleet has answered at least once. */
  loaded: boolean;
  /** The external inventory is switched on for this run. */
  externalOn: boolean;
  /** A discovery pass is in flight right now. */
  externalScanning: boolean;
};

/** Header text for the external side: off, working, or a count. Never a bare "0" while a scan
 *  is still running — that reads as an answer and it is not one. */
export function inventoryLabel(load: FleetLoad, externalCount: number): string {
  if (!load.externalOn) return "external off";
  if (load.externalScanning && externalCount === 0) return "external scanning…";
  return `${externalCount} external`;
}

/** Text for an empty list. Before the first answer this says so — the view used to assert
 *  "no sessions" on a machine whose fleet simply had not been delivered yet. */
export function emptyListText(load: FleetLoad, hint: string): string {
  return load.loaded ? `no sessions — ${hint}` : "loading sessions…";
}

const RECENT_ACTIVITY_MS = 30_000;
const ACTIVITY_BUCKET_MS = 60_000;

export function externalSelectionKey(ext: DiscoveredSession): string {
  return externalSessionKey(ext.provider, ext.host, ext.threadId);
}

export function resolveFleetItem(items: FleetItem[], key: string | null): FleetItem | null {
  if (key === null) return null;
  return items.find((item) => item.key === key) ?? null;
}

export function capabilitySummary(ext: DiscoveredSession): string {
  const cap = ext.capabilities;
  return [
    `inspect ${cap.inspect ? "yes" : "no"}`,
    `adopt ${cap.attemptAdopt ? "yes" : "no"}`,
    `fork ${cap.fork ? "yes" : "no"}`,
    `takeover ${cap.terminateAndAdopt ? "yes" : "no"}`,
    `release ${cap.releaseAtSource ? "yes" : "no"}`,
  ].join(" · ");
}

export function capabilityReasons(ext: DiscoveredSession): string {
  return ext.capabilities.reasons.length > 0 ? ext.capabilities.reasons.join(" · ") : "no capability blocks";
}

export function externalActionHint(ext: DiscoveredSession): string {
  if (ext.capabilities.attemptAdopt) return "a attempt adopt";
  if (ext.capabilities.fork || ext.capabilities.terminateAndAdopt || ext.capabilities.releaseAtSource) return "a ownership options";
  return `no ownership action: ${capabilityReasons(ext)}`;
}

export function writerSummary(ext: DiscoveredSession): string {
  const runtime = ext.writerRuntime;
  const evidence = ext.writerEvidence;
  if (runtime === null) return `${evidence} · no runtime classified`;
  const pid = runtime.pid === null ? "" : ` pid ${runtime.pid}`;
  return `${evidence} · ${runtime.kind}${pid} · ${runtime.reason}`;
}

/** Present a discovered provider-neutral thread as a read-only ListRow for shared rendering. */
export function externalToRow(ext: DiscoveredSession): ListRow {
  const tokens = ext.usedTokens !== null && ext.usedTokens > 0 ? fmtTokens(ext.usedTokens) : "-";
  const dirLabel = ext.dir ?? "cwd unknown";
  const nameBase = basename(ext.dir ?? "") || ext.provider;
  const running = ext.writerEvidence === "observed";
  return {
    session: {
      name: `${nameBase}·${ext.threadId.slice(0, 6)}`,
      dir: dirLabel,
      uuid: ext.threadId,
      flags: [],
      archived: false,
      resumeText: "continue",
      agent: ext.provider,
      chatEnabled: false,
      promptModules: [],
    },
    running,
    state: "external",
    lifecycleError: null,
    model: prettyModel(ext.lastModel),
    contextLabel: tokens,
    context: { text: tokens === "-" ? null : tokens, usedTokens: ext.usedTokens, limitTokens: null, percent: null },
    uptimeText: "—",
    uptimeSeconds: null,
    createdAt: null,
    lastMessage: ext.lastMessage,
    stale: [],
    lastActivityMs: ext.lastActivityMs,
  };
}

const recentlyActive = (ms: number | null): boolean => ms !== null && Date.now() - ms < RECENT_ACTIVITY_MS;

function activityBucket(row: ListRow): number {
  const ms = row.lastActivityMs ?? (row.createdAt ? Date.parse(row.createdAt) : null);
  return ms === null || Number.isNaN(ms) ? -1 : Math.floor(ms / ACTIVITY_BUCKET_MS);
}

function byActivity(a: FleetItem, b: FleetItem): number {
  return activityBucket(b.row) - activityBucket(a.row) || a.key.localeCompare(b.key);
}

export function buildItems(
  managed: ListRow[],
  discovered: DiscoveredSession[],
  host: string,
): { items: FleetItem[]; externalStart: number } {
  const managedItems = managed.map((row): FleetItem => ({
    key: managedSessionKey(row.session, host),
    row,
    external: false,
    ext: null,
    status: deriveStatus({
      running: row.running,
      isWorking: row.state === "working" || recentlyActive(row.lastActivityMs),
      lastMessage: row.lastMessage,
      blocked: row.state === "blocked",
    }),
    activityText: row.lastActivityMs !== null ? fmtAge(row.lastActivityMs) : null,
  }));
  const externalItems = discovered.map((ext): FleetItem => ({
    key: externalSelectionKey(ext),
    row: externalToRow(ext),
    external: true,
    ext,
    status: deriveStatus({
      running: ext.writerEvidence === "observed",
      isWorking: ext.writerEvidence === "observed" && recentlyActive(ext.lastActivityMs),
      lastMessage: ext.lastMessage,
    }),
    activityText: ext.lastActivityMs === null ? null : fmtAge(ext.lastActivityMs),
  }));
  managedItems.sort(byActivity);
  externalItems.sort(byActivity);
  return { items: [...managedItems, ...externalItems], externalStart: managedItems.length };
}
