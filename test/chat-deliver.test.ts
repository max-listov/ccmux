import { test, expect } from "bun:test";
import { atInteractiveMenu, chatDeliverable } from "../src/agent/claude/pane.ts";
import { recentInboundCount } from "../src/chat/deliver.ts";
import type { ChatMessage } from "../src/types.ts";

test("detects a permission menu (cursor on a numbered option) → not deliverable", () => {
  const p = "Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do\n";
  expect(atInteractiveMenu(p)).toBe(true);
  expect(chatDeliverable(p)).toBe(false);
});

test("detects the plan-approval menu → not deliverable", () => {
  const p = "Would you like to proceed?\n ❯ 1. Yes, and use auto mode\n   2. Yes, manually approve edits\n";
  expect(chatDeliverable(p)).toBe(false);
});

test("detects the resume-from-summary menu → not deliverable", () => {
  const p = " ❯ 1. Resume from summary (recommended)\n   2. Resume full session as-is\n";
  expect(chatDeliverable(p)).toBe(false);
});

test("normal idle input prompt IS deliverable", () => {
  const p = "─── m5-x ──\n❯ \n──────\n  Opus 4.8 (1M context)\n";
  expect(atInteractiveMenu(p)).toBe(false);
  expect(chatDeliverable(p)).toBe(true);
});

test("a WORKING session is deliverable — Claude queues typed input at the turn boundary", () => {
  const p = "⏺ doing stuff\n✻ Churning… (11s · ↓ 298 tokens)\n❯ \n";
  expect(atInteractiveMenu(p)).toBe(false);
  expect(chatDeliverable(p)).toBe(true);
});

test("an old numbered list in scrollback (not the live menu) doesn't false-trigger", () => {
  const scroll =
    "old list:\n ❯ 1. foo\n   2. bar\n" +
    Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n") +
    "\n❯ \n";
  expect(atInteractiveMenu(scroll)).toBe(false); // tail-only match ignores the scrolled-off cursor
});

test("recentInboundCount counts only in-window messages addressed to the recipient", () => {
  const now = 1_000_000_000;
  const at = (deltaMs: number, to: string): ChatMessage => ({
    id: "x",
    ts: new Date(now - deltaMs).toISOString(),
    from: "a",
    to,
    body: "",
    task: null,
  });
  const led: ChatMessage[] = [at(10_000, "b"), at(120_000, "b"), at(5_000, "c"), at(1_000, "b")];
  expect(recentInboundCount("b", led, now)).toBe(2); // two within 60s; the 120s-old one excluded
  expect(recentInboundCount("c", led, now)).toBe(1);
  expect(recentInboundCount("nobody", led, now)).toBe(0);
});
