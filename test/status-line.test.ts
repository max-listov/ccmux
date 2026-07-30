import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMetrics, originalCommand, minimalStatusline } from "../src/commands/statusLine.ts";

const L = (o: unknown): string => JSON.stringify(o);

test("extractMetrics reads Claude's OWN context fields (no regex over rendered text)", () => {
  const m = extractMetrics(L({ model: { display_name: "Opus 5" }, context_window: { used_percentage: 12, context_window_size: 1_000_000 }, cost: { total_cost_usd: 1.24 } }), 7);
  expect(m).toEqual({ ts: 7, pct: 12, contextSizeTokens: 1_000_000, model: "Opus 5", costUsd: 1.24 });
});

test("extractMetrics tolerates trivial/missing usage — null pct, never invented", () => {
  const m = extractMetrics(L({ model: { id: "claude-opus-5" }, context_window: { context_window_size: 1_000_000 } }), 7);
  expect(m).toEqual({ ts: 7, pct: null, contextSizeTokens: 1_000_000, model: "claude-opus-5", costUsd: null });
  expect(extractMetrics("garbage", 7)).toBeNull();
});

test("originalCommand resolves project → user precedence (so a project statusline isn't dropped)", () => {
  const home = mkdtempSync(join(tmpdir(), "sl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), L({ statusLine: { type: "command", command: "USER_SL" } }));
  const proj = mkdtempSync(join(tmpdir(), "sl-proj-"));
  expect(originalCommand(proj, home)).toBe("USER_SL"); // no project statusline → falls to user
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(join(proj, ".claude", "settings.json"), L({ statusLine: { type: "command", command: "PROJECT_SL" } }));
  expect(originalCommand(proj, home)).toBe("PROJECT_SL"); // project overrides user (the C2 fix)
});

test("originalCommand: project settings.local.json overrides settings.json (Claude precedence)", () => {
  const home = mkdtempSync(join(tmpdir(), "sl-h3-"));
  const proj = mkdtempSync(join(tmpdir(), "sl-p3-"));
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(join(proj, ".claude", "settings.json"), L({ statusLine: { command: "BASE" } }));
  writeFileSync(join(proj, ".claude", "settings.local.json"), L({ statusLine: { command: "LOCAL" } }));
  expect(originalCommand(proj, home)).toBe("LOCAL");
});

test("originalCommand skips our OWN injected command but keeps a user script containing 'status-line'", () => {
  const home = mkdtempSync(join(tmpdir(), "sl-h2-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), L({ statusLine: { command: "ccmux status-line" } }));
  expect(originalCommand(home, home)).toBeNull(); // our own standalone `status-line` subcommand → skipped
  // a real user statusline whose path merely CONTAINS the substring must NOT be skipped (guard is word-precise)
  const u = mkdtempSync(join(tmpdir(), "sl-u-"));
  mkdirSync(join(u, ".claude"), { recursive: true });
  writeFileSync(join(u, ".claude", "settings.json"), L({ statusLine: { command: "~/bin/status-line-pretty.sh" } }));
  expect(originalCommand(u, u)).toBe("~/bin/status-line-pretty.sh");
  const empty = mkdtempSync(join(tmpdir(), "sl-empty-"));
  expect(originalCommand(empty, empty)).toBeNull();
});

test("minimalStatusline: a useful default (model + context%) when the user has no statusline — never a blank bar", () => {
  expect(minimalStatusline({ ts: 1, pct: 12, contextSizeTokens: 1_000_000, model: "Opus 5", costUsd: 0 })).toBe("Opus 5 · 120k/1.0M 12%");
  expect(minimalStatusline({ ts: 1, pct: null, contextSizeTokens: null, model: "Opus 5", costUsd: null })).toBe("Opus 5");
  expect(minimalStatusline({ ts: 1, pct: null, contextSizeTokens: null, model: null, costUsd: null })).toBe("");
});
