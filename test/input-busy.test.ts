import { test, expect } from "bun:test";
import { inputBusy, chatDeliverable } from "../src/agent/claude/pane.ts";

// Delivering chat appends a literal and presses Enter, so the ONE hazard is a human's half-written
// line: ours would be glued onto it and sent. Watching an attached pane is harmless — that's why the
// gate asks "is the composer occupied", not "is anyone attached" (which used to block delivery for as
// long as you kept the pane open — a real incident: a letter sat undelivered while the human watched).

/** The real bottom-of-pane shape: framed composer above the statusline. */
const pane = (composer: string, history = "some earlier output"): string =>
  [
    history,
    "❯ an EARLIER user message — Claude prefixes history with ❯ too",
    "⏺ the agent's reply",
    "──────────────────────────────────────────── host-a-demo ──",
    composer,
    "────────────────────────────────────────────────────────",
    "   Opus 5 · 120.0k/1.0M 12%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");

test("empty composer → not busy (watching a pane must never block delivery)", () => {
  expect(inputBusy(pane("❯ "))).toBe(false);
  expect(inputBusy(pane("❯"))).toBe(false);
});

test("typed-but-unsent text → busy (our Enter would send THEIR line)", () => {
  expect(inputBusy(pane("❯ почини таймаут в toolkit tg_file"))).toBe(true);
  expect(inputBusy(pane('❯ {"ts":"2026-08-03T10:12:46.114Z","level":"info"'))).toBe(true);
});

test("history lines starting with ❯ are NOT read as live input", () => {
  // the composer (last ❯ near the bottom) is empty; an older ❯ line sits above it
  expect(inputBusy(pane("❯ "))).toBe(false);
});

test("no composer in view (booting / alt-screen) → not busy, delivery proceeds", () => {
  expect(inputBusy("loading…\n\n")).toBe(false);
  expect(inputBusy("")).toBe(false);
});

test("the menu gate is untouched — that hazard is real and still holds delivery", () => {
  const menu = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");
  expect(chatDeliverable(menu)).toBe(false);
  expect(chatDeliverable(pane("❯ "))).toBe(true);
});
