import { describe, expect, test } from "bun:test";
import { buildItems, externalSelectionKey, externalToRow, resolveFleetItem } from "../src/tui/fleet.ts";
import { managedSessionKey } from "../src/external/keys.ts";
import { externalDetailLines } from "../src/tui/externalView.ts";
import { fmtAge } from "../src/tui/format.ts";
import type { ListRow } from "../src/commands/list.ts";
import type { DiscoveredSession } from "../src/tui/discover.ts";

const MIN = 60_000;

function row(name: string, lastActivityMs: number | null, createdAt: string | null = null): ListRow {
  return {
    session: { name, dir: `/tmp/${name}`, uuid: `00000000-0000-4000-8000-${name.padStart(12, "0")}`, flags: [], archived: false, resumeText: "continue", agent: "claude", chatEnabled: false, promptModules: [] },
  running: true,
  lifecycleError: null,
    stale: [],
    state: "idle",
    model: null,
    contextLabel: "-",
    context: { text: null, usedTokens: null, limitTokens: null, percent: null },
    uptimeText: "1h",
    uptimeSeconds: 3600,
    createdAt,
    lastMessage: null,
    lastActivityMs,
  };
}

function ext(dir: string, lastActivityMs: number | null, provider: "claude" | "codex" = "codex"): DiscoveredSession {
  const suffix = String([...dir].reduce((sum, ch) => sum + (ch.codePointAt(0) ?? 0), 0)).padStart(12, "0");
  return {
    key: `external:${provider}:host-A#11111111-0000-4000-8000-${suffix}`,
    plane: "external",
    provider,
    host: "host-A",
    threadId: `11111111-0000-4000-8000-${suffix}`,
    dir: `/tmp/${dir}`,
    path: `/tmp/${dir}.jsonl`,
    origin: provider === "codex" ? "vscode" : "cli",
    storage: "stored",
    writerEvidence: "observed",
    writerRuntime: { kind: "desktop", pid: 42, startTime: null, processGroup: null, reason: "desktop owns the writer" },
    capabilities: { inspect: true, attemptAdopt: false, fork: false, terminateAndAdopt: false, releaseAtSource: true, reasons: ["release at source first"] },
    lastActivityMs,
    lastModel: null,
    usedTokens: null,
    lastMessage: null,
  };
}

const names = (items: { row: ListRow }[]): string[] => items.map((it) => it.row.session.name);

describe("buildItems ordering", () => {
  test("managed sort newest-activity first", () => {
    const now = Date.now();
    const { items } = buildItems([row("old", now - 60 * MIN), row("fresh", now), row("mid", now - 5 * MIN)], [], "host-A");
    expect(names(items)).toEqual(["fresh", "mid", "old"]);
  });

  test("same minute bucket → stable name order (no per-tick reshuffle)", () => {
    // two sessions written seconds apart inside one minute bucket must NOT reorder
    const bucketStart = Math.floor(Date.now() / MIN) * MIN;
    const a = row("bbb", bucketStart + 5_000);
    const b = row("aaa", bucketStart + 40_000);
    expect(names(buildItems([a, b], [], "host-A").items)).toEqual(["aaa", "bbb"]);
    expect(names(buildItems([b, a], [], "host-A").items)).toEqual(["aaa", "bbb"]);
  });

  test("no transcript yet → falls back to tmux start time (just created sorts as active)", () => {
    const now = Date.now();
    const justCreated = row("newborn", null, new Date(now).toISOString());
    const { items } = buildItems([row("old", now - 60 * MIN), justCreated], [], "host-A");
    expect(names(items)).toEqual(["newborn", "old"]);
  });

  test("no activity and no start time → bottom", () => {
    const now = Date.now();
    const { items } = buildItems([row("dead", null), row("live", now)], [], "host-A");
    expect(names(items)).toEqual(["live", "dead"]);
  });

  test("external sort within their own section; externalStart preserved", () => {
    const now = Date.now();
    const { items, externalStart } = buildItems(
      [row("managed-old", now - 30 * MIN), row("managed-new", now)],
      [ext("ext-old", now - 30 * MIN), ext("ext-new", now)],
      "host-A",
    );
    expect(externalStart).toBe(2);
    expect(names(items)).toEqual(["managed-new", "managed-old", "ext-new·111111", "ext-old·111111"]);
    expect(items.slice(externalStart).every((it) => it.external)).toBe(true);
  });

  test("activityText is precomputed for managed and external", () => {
    const now = Date.now();
    const { items } = buildItems([row("m", now - 5 * MIN), row("silent", null)], [ext("e", now)], "host-A");
    const byName = new Map(items.map((it) => [it.row.session.name, it]));
    expect(byName.get("m")?.activityText).toBe("5m ago");
    expect(byName.get("silent")?.activityText).toBeNull();
    expect(byName.get("e·111111")?.activityText).toBe("now");
  });
});

describe("fleet route identity and external evidence", () => {
  test("external selection survives metadata churn but not route identity changes", () => {
    const original = ext("worktree", Date.now());
    const metadataChanged: DiscoveredSession = { ...original, dir: "/tmp/renamed", origin: "app-server", lastActivityMs: null };
    expect(externalSelectionKey(metadataChanged)).toBe(externalSelectionKey(original));
    expect(externalSelectionKey({ ...original, host: "host-B" })).not.toBe(externalSelectionKey(original));
    expect(externalSelectionKey({ ...original, provider: "claude" })).not.toBe(externalSelectionKey(original));
  });

  test("managed identity includes host, provider, name and full thread id", () => {
    const session = row("agent-A", Date.now()).session;
    const codexSession: typeof session = { ...session, agent: "codex" };
    const key = managedSessionKey(codexSession, "host-A");
    expect(key).not.toBe(managedSessionKey(codexSession, "host-B"));
    expect(key).not.toBe(managedSessionKey(session, "host-A"));
    expect(key).not.toBe(managedSessionKey({ ...codexSession, name: "agent-B" }, "host-A"));
  });

  test("fresh resolution uses the stable key and rejects a replaced route", () => {
    const first = ext("worktree", Date.now());
    const built = buildItems([], [first], "host-A").items;
    expect(resolveFleetItem(built, externalSelectionKey(first))?.ext?.threadId).toBe(first.threadId);
    expect(resolveFleetItem(built, externalSelectionKey({ ...first, host: "host-B" }))).toBeNull();
  });

  test("external row and card evidence preserve provider, full UUID, origin and capability reason", () => {
    const item = ext("worktree", Date.now());
    const row = externalToRow(item);
    expect(row.session.agent).toBe("codex");
    expect(row.session.uuid).toBe(item.threadId);
    expect(row.running).toBe(true);
    const lines = externalDetailLines(item);
    expect(lines.join("\n")).toContain(item.threadId);
    expect(lines.join("\n")).toContain("codex@host-A");
    expect(lines.join("\n")).toContain("origin vscode");
    expect(lines.join("\n")).toContain("release at source first");
  });

  test("writer not observed is not presented as a running external writer", () => {
    const item = ext("worktree", Date.now());
    expect(externalToRow({ ...item, writerEvidence: "none-observed", writerRuntime: null }).running).toBe(false);
  });
});

describe("fmtAge", () => {
  test("tiers: now / minutes / hours / days", () => {
    const now = Date.now();
    expect(fmtAge(now - 10_000)).toBe("now");
    expect(fmtAge(now - 5 * MIN)).toBe("5m ago");
    expect(fmtAge(now - 3 * 3600_000)).toBe("3h ago");
    expect(fmtAge(now - 2 * 86400_000)).toBe("2d ago");
  });
});
