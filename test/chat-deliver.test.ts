import { test, expect } from "bun:test";
import { atInteractiveMenu, chatDeliverable } from "../src/agent/claude/pane.ts";
import { recentInboundCount, isConditional, notBeforeDue } from "../src/chat/deliver.ts";
import type { ChatMessage } from "../src/types.ts";

const baseMsg: ChatMessage = { id: "x", ts: "2026-07-24T00:00:00.000Z", from: "a", to: "b", body: "", task: null, defer: false, onBehalfOf: null, notBefore: null };

test("isConditional: deferred OR time-delayed mail is off-cursor; plain mail is immediate", () => {
  expect(isConditional(baseMsg)).toBe(false);
  expect(isConditional({ ...baseMsg, defer: true })).toBe(true);
  expect(isConditional({ ...baseMsg, notBefore: "2030-01-01T00:00:00.000Z" })).toBe(true);
});

test("notBeforeDue: null=due, future=not-due, past=due, unparseable=due (never trap forever)", () => {
  const now = 1_000_000_000;
  const mk = (nb: string | null) => ({ ...baseMsg, notBefore: nb });
  expect(notBeforeDue(mk(null), now)).toBe(true);
  expect(notBeforeDue(mk(new Date(now + 5000).toISOString()), now)).toBe(false);
  expect(notBeforeDue(mk(new Date(now - 5000).toISOString()), now)).toBe(true);
  expect(notBeforeDue(mk("not-a-date"), now)).toBe(true);
});

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
    defer: false,
    onBehalfOf: null,
    notBefore: null,
  });
  const led: ChatMessage[] = [at(10_000, "b"), at(120_000, "b"), at(5_000, "c"), at(1_000, "b")];
  expect(recentInboundCount("b", led, now)).toBe(2); // two within 60s; the 120s-old one excluded
  expect(recentInboundCount("c", led, now)).toBe(1);
  expect(recentInboundCount("nobody", led, now)).toBe(0);
});
