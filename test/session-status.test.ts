import { test, expect, afterAll } from "bun:test";
import { writeLifecycle, readLifecycle, writeMetrics, readMetrics, clearStatus, resolveLiveState, SUPERVISOR_CLOSED_EVENT } from "../src/agent/sessionStatus.ts";

const lifecycle = (state: "working" | "idle", event: string) => ({ state, event, ts: 1 });

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
  expect(resolveLiveState("working", lifecycle("idle", "Stop"), { settled: true, why: "turn-ended" })).toBe("working");
  expect(resolveLiveState("idle", lifecycle("working", "UserPromptSubmit"), { settled: false, why: "working" })).toBe("idle");
  expect(resolveLiveState("indeterminate", lifecycle("idle", "Stop"), { settled: false, why: "quiet-unproven" })).toBe("idle");
  expect(resolveLiveState("indeterminate", lifecycle("working", "UserPromptSubmit"), { settled: false, why: "quiet-unproven" })).toBe("working");
  expect(resolveLiveState("indeterminate", lifecycle("working", "UserPromptSubmit"), { settled: true, why: "idle-after-interrupt" })).toBe("idle");
  expect(resolveLiveState("indeterminate", null, null)).toBe("idle");
});

test("one ready frame without a spinner does not split one working turn", () => {
  const frames = ["working", "indeterminate", "working"] as const;
  const evidence = { settled: false, why: "quiet-unproven" } as const;
  expect(frames.map((paneState) => resolveLiveState(paneState, lifecycle("working", "UserPromptSubmit"), evidence))).toEqual([
    "working",
    "working",
    "working",
  ]);
});

test("bounded pane evidence bridges a blank frame without lifecycle identity", () => {
  const frames = ["working", "indeterminate", "working"] as const;
  const evidence = { settled: false, why: "quiet-unproven" } as const;
  for (const status of [lifecycle("idle", SUPERVISOR_CLOSED_EVENT), null] as const) {
    expect(frames.map((paneState) => resolveLiveState(paneState, status, evidence))).toEqual([
      "working",
      "working",
      "working",
    ]);
  }
});

test("anonymous work expires instead of becoming permanently working", () => {
  const settled = { settled: true, why: "idle-after-interrupt" } as const;
  expect(resolveLiveState("indeterminate", null, settled)).toBe("idle");
  expect(resolveLiveState("indeterminate", lifecycle("idle", SUPERVISOR_CLOSED_EVENT), settled)).toBe("idle");
  expect(resolveLiveState("indeterminate", lifecycle("idle", "SessionStart"), { settled: false, why: "not-drawn" })).toBe("idle");
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
