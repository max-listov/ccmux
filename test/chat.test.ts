import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineConfigSchema } from "../src/config/schema.ts";
import {
  appendMessage,
  loadLedger,
  loadCursors,
  unreadFor,
  markRead,
  chatPaths,
  fmtMessage,
  nextForRecipient,
} from "../src/chat/store.ts";
import type { ChatMessage } from "../src/types.ts";

// A schema-valid config whose sessions file lives in a fresh temp dir → chat files are temp too.
function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-chat-"));
  return MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/p",
    rcPrefix: "test",
    sessionsFile: join(dir, ".ccmux-sessions"),
    bootLabel: "b",
  });
}

let seq = 0;
function msg(from: string, to: string, body: string, task: string | null = null): ChatMessage {
  seq += 1;
  return { id: `id-${seq}`, ts: "2026-07-19T10:00:00.000Z", from, to, body, task, defer: false, onBehalfOf: null, notBefore: null };
}

test("append + loadLedger round-trips in order", () => {
  const m = tempConfig();
  expect(loadLedger(m)).toEqual([]);
  appendMessage(m, msg("a", "b", "one"));
  appendMessage(m, msg("a", "c", "two"));
  appendMessage(m, msg("a", "b", "three"));
  const led = loadLedger(m);
  expect(led.map((x) => x.body)).toEqual(["one", "two", "three"]);
});

test("unreadFor filters by recipient and read cursor; markRead clears it", async () => {
  const m = tempConfig();
  appendMessage(m, msg("a", "b", "b1"));
  appendMessage(m, msg("a", "c", "c1"));
  appendMessage(m, msg("a", "b", "b2"));

  let led = loadLedger(m);
  expect(unreadFor("b", led, loadCursors(m)).map((u) => u.msg.body)).toEqual(["b1", "b2"]);
  expect(unreadFor("c", led, loadCursors(m)).map((u) => u.msg.body)).toEqual(["c1"]);
  expect(unreadFor("nobody", led, loadCursors(m))).toEqual([]);

  await markRead(m, "b", led.length);
  expect(unreadFor("b", led, loadCursors(m))).toEqual([]); // b caught up
  expect(unreadFor("c", led, loadCursors(m)).map((u) => u.msg.body)).toEqual(["c1"]); // c unaffected

  // a NEW message to b after markRead is unread again
  appendMessage(m, msg("a", "b", "b3"));
  led = loadLedger(m);
  expect(unreadFor("b", led, loadCursors(m)).map((u) => u.msg.body)).toEqual(["b3"]);
});

test("cursors persist to disk across loads", async () => {
  const m = tempConfig();
  appendMessage(m, msg("a", "b", "x"));
  await markRead(m, "b", loadLedger(m).length);
  expect(loadCursors(m).read["b"]).toBe(1);
});

test("a corrupt ledger line fails loud with its number", () => {
  const m = tempConfig();
  appendMessage(m, msg("a", "b", "ok"));
  const { ledger } = chatPaths(m);
  writeFileSync(ledger, `${'{"bad json"'}\n`, { flag: "a" });
  expect(() => loadLedger(m)).toThrow(/chat ledger:2 — invalid JSON/);
});

test("nextForRecipient finds the first message to a recipient from a cursor (skips others)", () => {
  const m = tempConfig();
  appendMessage(m, msg("a", "c", "c1"));
  appendMessage(m, msg("a", "b", "b1"));
  appendMessage(m, msg("a", "b", "b2"));
  const led = loadLedger(m);
  expect(nextForRecipient("b", led, 0)?.idx).toBe(1); // skips c1 at 0
  expect(nextForRecipient("b", led, 2)?.idx).toBe(2);
  expect(nextForRecipient("b", led, 3)).toBeNull();
  expect(nextForRecipient("nobody", led, 0)).toBeNull();
});

test("fmtMessage renders direction, task, and body", () => {
  expect(fmtMessage(msg("a", "b", "hi"))).toContain("a → b");
  expect(fmtMessage(msg("a", "b", "hi", "deploy"))).toContain("(task: deploy)");
  expect(fmtMessage(msg("a", "b", "hello world"))).toMatch(/a → b: hello world$/);
});
