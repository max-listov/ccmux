import { test, expect } from "bun:test";
import { preview, PREVIEW_LIMIT } from "../src/util/preview.ts";
import { looksLikeMessage } from "../src/commands/send.ts";
import { buildPrompt } from "../src/agent/managePrompt.ts";

// An agent wrote a multi-paragraph review request with `ccmux send` and got the entire text echoed
// back at it. Two separate faults met there: a confirmation that repeats what you just wrote, and a
// command whose name reads like "write to" while it only presses keys.

test("a short confirmation is shown whole; a long one is cut and states its true length", () => {
  expect(preview("/compact")).toBe("/compact");
  const long = "x".repeat(PREVIEW_LIMIT + 40);
  expect(preview(long)).toBe(`${"x".repeat(PREVIEW_LIMIT)}… (${PREVIEW_LIMIT + 40} chars)`);
  // The length matters more than the tail: it is what proves nothing was cut on the way OUT.
  expect(preview(long)).toContain(`(${long.length} chars)`);
});

test("a slash command is keystrokes and draws no advice, however it is sent", () => {
  expect(looksLikeMessage("/compact", true)).toBe(false);
  expect(looksLikeMessage(`/model opus ${"x".repeat(300)}`, true)).toBe(false);
});

test("long prose to a chat-capable session is what the nudge is for", () => {
  const letter = "Привет! Пишу из соседней сессии. ".repeat(12);
  expect(looksLikeMessage(letter, true)).toBe(true);
  // No chat on the far side → `msg` would be refused anyway, so advising it would be wrong.
  expect(looksLikeMessage(letter, false)).toBe(false);
  // Short text stays keystrokes: answering a prompt, typing "yes", pasting a path.
  expect(looksLikeMessage("да, продолжай", true)).toBe(false);
});

test("the prompt says what `send` actually does, so the name stops implying 'write to'", () => {
  const p = buildPrompt("cc-x", "ccmux", "claude", "ccmux");
  expect(p).toContain("PRESSES KEYS");
  expect(p).toContain("It is NOT how you write to an agent");
  // And names the consequences that make it the wrong tool for a letter.
  expect(p).toContain("nothing records it");
  expect(p).toContain("selection menu");
});
