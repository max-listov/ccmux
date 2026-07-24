import { describe, expect, test } from "bun:test";
import { buildItems } from "../src/tui/fleet.ts";
import { fmtAge } from "../src/tui/format.ts";
import type { ListRow } from "../src/commands/list.ts";
import type { DiscoveredSession } from "../src/tui/discover.ts";

const MIN = 60_000;

function row(name: string, lastActivityMs: number | null, createdAt: string | null = null): ListRow {
  return {
    session: { name, dir: `/tmp/${name}`, uuid: `00000000-0000-4000-8000-${name.padStart(12, "0")}`, flags: [], archived: false, resumeText: "continue", agent: "claude", chatEnabled: false, promptModules: [] },
    running: true,
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

function ext(dir: string, lastActivityMs: number): DiscoveredSession {
  return { uuid: `11111111-0000-4000-8000-${dir.padStart(12, "0")}`, dir: `/tmp/${dir}`, path: `/tmp/${dir}.jsonl`, lastActivityMs, model: null, usedTokens: null, lastMessage: null };
}

const names = (items: { row: ListRow }[]): string[] => items.map((it) => it.row.session.name);

describe("buildItems ordering", () => {
  test("managed sort newest-activity first", () => {
    const now = Date.now();
    const { items } = buildItems([row("old", now - 60 * MIN), row("fresh", now), row("mid", now - 5 * MIN)], []);
    expect(names(items)).toEqual(["fresh", "mid", "old"]);
  });

  test("same minute bucket → stable name order (no per-tick reshuffle)", () => {
    // two sessions written seconds apart inside one minute bucket must NOT reorder
    const bucketStart = Math.floor(Date.now() / MIN) * MIN;
    const a = row("bbb", bucketStart + 5_000);
    const b = row("aaa", bucketStart + 40_000);
    expect(names(buildItems([a, b], []).items)).toEqual(["aaa", "bbb"]);
    expect(names(buildItems([b, a], []).items)).toEqual(["aaa", "bbb"]);
  });

  test("no transcript yet → falls back to tmux start time (just created sorts as active)", () => {
    const now = Date.now();
    const justCreated = row("newborn", null, new Date(now).toISOString());
    const { items } = buildItems([row("old", now - 60 * MIN), justCreated], []);
    expect(names(items)).toEqual(["newborn", "old"]);
  });

  test("no activity and no start time → bottom", () => {
    const now = Date.now();
    const { items } = buildItems([row("dead", null), row("live", now)], []);
    expect(names(items)).toEqual(["live", "dead"]);
  });

  test("external sort within their own section; externalStart preserved", () => {
    const now = Date.now();
    const { items, externalStart } = buildItems(
      [row("managed-old", now - 30 * MIN), row("managed-new", now)],
      [ext("ext-old", now - 30 * MIN), ext("ext-new", now)],
    );
    expect(externalStart).toBe(2);
    expect(names(items)).toEqual(["managed-new", "managed-old", "ext-new·111111", "ext-old·111111"]);
    expect(items.slice(externalStart).every((it) => it.external)).toBe(true);
  });

  test("activityText is precomputed for managed and external", () => {
    const now = Date.now();
    const { items } = buildItems([row("m", now - 5 * MIN), row("silent", null)], [ext("e", now)]);
    const byName = new Map(items.map((it) => [it.row.session.name, it]));
    expect(byName.get("m")?.activityText).toBe("5m ago");
    expect(byName.get("silent")?.activityText).toBeNull();
    expect(byName.get("e·111111")?.activityText).toBe("now");
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
