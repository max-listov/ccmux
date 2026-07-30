import { test, expect, afterAll } from "bun:test";
import { writeLifecycle, readLifecycle, writeMetrics, readMetrics, clearStatus, resolveLiveState } from "../src/agent/sessionStatus.ts";

// Unique name so the roundtrip never collides with a real managed session; cleaned up after.
const NAME = "zz-status-selftest";
afterAll(() => clearStatus(NAME));

test("lifecycle roundtrip (single-writer file, zod-validated on read)", async () => {
  await writeLifecycle(NAME, { state: "working", ts: 1, event: "UserPromptSubmit" });
  expect(readLifecycle(NAME)).toEqual({ state: "working", ts: 1, event: "UserPromptSubmit" });
});

test("metrics roundtrip", async () => {
  await writeMetrics(NAME, { ts: 2, pct: 12, contextSizeTokens: 1_000_000, model: "Opus 5", costUsd: 1.2 });
  expect(readMetrics(NAME)?.pct).toBe(12);
});

test("resolveLiveState is pane-decisive — a stale lifecycle `working` never beats a drawn idle pane", () => {
  expect(resolveLiveState(true, true, "idle")).toBe("working"); // live spinner wins
  expect(resolveLiveState(false, true, "working")).toBe("idle"); // the interrupt fix: idle pane overrides stale hook working
  expect(resolveLiveState(false, false, "working")).toBe("working"); // cold-start (pane not drawn) → hook fills the gap
  expect(resolveLiveState(false, false, null)).toBe("idle"); // nothing known → idle
});

test("missing / malformed file → null (safeParse guards, never throws)", () => {
  expect(readLifecycle("zz-nonexistent-xyz")).toBeNull();
  expect(readMetrics("zz-nonexistent-xyz")).toBeNull();
});

test("clearStatus drops BOTH files (stopped session shows no stale state)", async () => {
  await writeLifecycle(NAME, { state: "idle", ts: 3, event: "Stop" });
  await writeMetrics(NAME, { ts: 3, pct: null, contextSizeTokens: null, model: null, costUsd: null });
  clearStatus(NAME);
  expect(readLifecycle(NAME)).toBeNull();
  expect(readMetrics(NAME)).toBeNull();
});
