import { test, expect } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatForTg, classifyHttpStatus, mirrorPending } from "../src/chat/telegram.ts";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { appendMessage, chatPaths } from "../src/chat/store.ts";
import type { ChatMessage } from "../src/types.ts";

const msg = (from: string, to: string, body: string, task: string | null = null): ChatMessage => ({
  id: "1",
  ts: "2026-07-19T10:00:00.000Z",
  from,
  to,
  body,
  task,
});

test("formatForTg bolds the routing header and renders task + multi-line body verbatim", () => {
  expect(formatForTg(msg("a", "b", "hi"))).toBe("<b>a → b</b>\nhi");
  expect(formatForTg(msg("a", "b", "l1\nl2", "deploy"))).toBe("<b>a → b · task: deploy</b>\nl1\nl2");
});

test("formatForTg marks owner-directed messages (an agent wrote to the human)", () => {
  expect(formatForTg(msg("dev-b", "owner", "a poem for you"))).toBe("<b>📩 for you — from dev-b</b>\na poem for you");
  expect(formatForTg(msg("a", "b", "hi"))).not.toContain("📩"); // agent↔agent stays plain
});

test("formatForTg escapes HTML-special chars in the body so parse_mode=HTML never trips a 400", () => {
  expect(formatForTg(msg("a", "b", "1 < 2 && 3 > 2"))).toBe("<b>a → b</b>\n1 &lt; 2 &amp;&amp; 3 &gt; 2");
});

test("classifyHttpStatus: 4xx permanent (skip), 429/5xx transient (retry)", () => {
  expect(classifyHttpStatus(400)).toBe("permanent");
  expect(classifyHttpStatus(403)).toBe("permanent");
  expect(classifyHttpStatus(404)).toBe("permanent");
  expect(classifyHttpStatus(429)).toBe("transient");
  expect(classifyHttpStatus(500)).toBe("transient");
  expect(classifyHttpStatus(502)).toBe("transient");
});

test("mirrorPending is a fail-soft no-op when telegram is unconfigured (no network, no cursor)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-tg-"));
  const m = MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/p",
    rcPrefix: "test",
    sessionsFile: join(dir, ".ccmux-sessions"),
    bootLabel: "b",
  });
  appendMessage(m, msg("a", "b", "hi"));
  await mirrorPending(m); // must not throw and must not touch the cursor file
  expect(existsSync(chatPaths(m).cursors)).toBe(false);
});
