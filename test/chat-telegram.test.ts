import { test, expect } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatForTg, classifyHttpStatus, mirrorPending } from "../src/chat/telegram.ts";
import { ChatCursorsSchema } from "../src/config/schema.ts";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { appendMessage, chatPaths } from "../src/chat/store.ts";
import type { ChatMessage } from "../src/types.ts";

const msg = (from: string, to: string, body: string, task: string | null = null): ChatMessage => ({
  id: "1",
  ts: "2026-07-19T10:00:00.000Z",
  fromMachine: null,
  from,
  to,
  body,
  task,
  defer: false,
  onBehalfOf: null,
  notBefore: null,
});

test("formatForTg bolds the routing header and renders task + multi-line body verbatim", () => {
  expect(formatForTg(msg("a", "b", "hi"), "host-a")).toBe("<b>[host-a:a → host-a:b]</b>\n\nhi");
  expect(formatForTg(msg("a", "b", "l1\nl2", "deploy"), "host-a")).toBe("<b>[host-a:a → host-a:b]</b> · <i>deploy</i>\n\nl1\nl2");
});

test("formatForTg marks owner-directed messages (an agent wrote to the human)", () => {
  expect(formatForTg(msg("agent-b", "owner", "a poem for you"), "host-a")).toBe("📩 <b>[host-a:agent-b → you]</b>\n\na poem for you");
  expect(formatForTg(msg("a", "b", "hi"), "host-a")).not.toContain("📩"); // agent↔agent stays plain
});

test("every mirrored line is a usable ADDRESS — the point of mirroring a whole fleet into one chat", () => {
  // Once all machines mirror into the same chat, bare names are ambiguous: the same session name
  // commonly exists on two boxes. The recipient is local to the ledger being mirrored; a sender that
  // crossed machines keeps its OWN label rather than borrowing the mirroring machine's.
  const crossed = { ...msg("agent-a", "agent-b", "done"), fromMachine: "host-b" };
  expect(formatForTg(crossed, "host-a")).toBe("<b>[host-b:agent-a → host-a:agent-b]</b>\n\ndone");
});

test("formatForTg escapes HTML-special chars in the body so parse_mode=HTML never trips a 400", () => {
  expect(formatForTg(msg("a", "b", "1 < 2 && 3 > 2"), "host-a")).toBe("<b>[host-a:a → host-a:b]</b>\n\n1 &lt; 2 &amp;&amp; 3 &gt; 2");
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

test("turning the mirror ON starts a live feed — it never replays the machine's history", () => {
  // Learned the hard way: enabling the mirror on two servers instantly re-sent 25 past messages,
  // because a cursor defaulting to 0 makes every message ever written an "un-mirrored backlog".
  // `null` distinguishes "never ran here" from "legitimately at the start".
  expect(ChatCursorsSchema.parse({}).telegram).toBeNull();
  // An existing cursor file keeps its number and is unaffected by the change.
  expect(ChatCursorsSchema.parse({ telegram: 7 }).telegram).toBe(7);
});

test("the route line is a bracketed HEADER with air under it, not a first line of the body", () => {
  // On a phone the header and the body ran together and stopped reading as two different things.
  const out = formatForTg(msg("a", "b", "body"), "host-a");
  const [head, blank, ...rest] = out.split("\n");
  expect(head).toBe("<b>[host-a:a → host-a:b]</b>");
  expect(blank).toBe("");
  expect(rest.join("\n")).toBe("body");
});
