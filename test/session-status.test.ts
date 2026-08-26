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

test("resolveLiveState requires positive or bounded evidence for each transition", () => {
  expect(resolveLiveState("working", "idle", true)).toBe("working");
  expect(resolveLiveState("indeterminate", "idle", false)).toBe("idle");
  expect(resolveLiveState("indeterminate", "working", false)).toBe("working");
  expect(resolveLiveState("indeterminate", "working", true)).toBe("idle");
  expect(resolveLiveState("indeterminate", null, null)).toBe("idle");
});

test("one ready frame without a spinner does not split one working turn", () => {
  const frames = ["working", "indeterminate", "working"] as const;
  expect(frames.map((paneState) => resolveLiveState(paneState, "working", false))).toEqual([
    "working",
    "working",
    "working",
  ]);
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
