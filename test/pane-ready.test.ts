import { test, expect } from "bun:test";
import { scanPane } from "../src/agent/claude/pane.ts";

// Real captured chrome (ansi-stripped) from a booted claude pane — the ready marker is the
// permission-mode footer while idle, the interrupt hint while working. Both are claude-native and
// INDEPENDENT of the (user-defined) statusline, which is why the model no longer needs to be there.

const IDLE_PANE = [
  "⏺ done",
  "──────────────────────────────────── host-a-work ──",
  "❯ ",
  "   Fable 5 · 250.0k/1.0M 25%  sess ↓254.3k ↑1.3k",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

const WORKING_PANE = ["✻ Transmuting…", "  (esc to interrupt)"].join("\n");

const BOOTING_PANE = ["", "loading…", ""].join("\n");

test("a booted idle pane is ready and idle — even on a Fable statusline (no model whitelist)", () => {
  const scan = scanPane(IDLE_PANE);
  expect(scan.ready).toBe(true);
  expect(scan.state).toBe("idle");
  expect(scan.context.percent).toBe(25); // context still read structurally
});

test("a working pane is ready and working", () => {
  const scan = scanPane(WORKING_PANE);
  expect(scan.ready).toBe(true);
  expect(scan.state).toBe("working");
});

test("a half-booted blank pane is NOT ready (waitReady keeps polling)", () => {
  expect(scanPane(BOOTING_PANE).ready).toBe(false);
});

test("PaneScan no longer carries a model field", () => {
  expect("model" in scanPane(IDLE_PANE)).toBe(false);
});
