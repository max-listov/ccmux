import { test, expect } from "bun:test";
import { toolCategory, toolDisplayName, toolLabel } from "../src/agent/toolMeta.ts";
import { resultSummary, countLines } from "../src/agent/toolSummary.ts";
import { parse } from "../src/agent/claude/transcript.ts";

test("toolCategory buckets the common tools", () => {
  expect(toolCategory("Read")).toBe("read");
  expect(toolCategory("Grep")).toBe("read");
  expect(toolCategory("Edit")).toBe("edit");
  expect(toolCategory("Write")).toBe("write");
  expect(toolCategory("Bash")).toBe("run");
  expect(toolCategory("WebSearch")).toBe("search");
  expect(toolCategory("mcp__firecrawl__firecrawl_search")).toBe("mcp");
  expect(toolCategory("Agent")).toBe("agent");
  expect(toolCategory("AskUserQuestion")).toBe("ask");
  expect(toolCategory("SomethingElse")).toBe("tool");
});

test("toolDisplayName strips mcp prefix + tidies known names", () => {
  expect(toolDisplayName("mcp__firecrawl__firecrawl_search")).toBe("firecrawl_search");
  expect(toolDisplayName("AskUserQuestion")).toBe("Ask");
  expect(toolDisplayName("Bash")).toBe("Bash");
});

test("toolLabel inflects verb tense for verb-categories, keeps identity for others", () => {
  expect(toolLabel("Edit", true)).toBe("Editing");
  expect(toolLabel("Edit", false)).toBe("Edited");
  expect(toolLabel("Read", false)).toBe("Read");
  expect(toolLabel("mcp__x__y", false)).toBe("y"); // identity, not a verb
});

test("resultSummary: edit diff, write/read/run line counts, error short-circuit", () => {
  expect(resultSummary("Edit", { old_string: "a\nb\nc", new_string: "x" }, "ok", false)).toBe("+1 −3");
  expect(resultSummary("MultiEdit", { edits: [{ old_string: "a", new_string: "x\ny" }, { old_string: "b\nc", new_string: "z" }] }, "", false)).toBe("+3 −3");
  expect(resultSummary("Write", { content: "l1\nl2\nl3" }, "", false)).toBe("wrote 3 lines");
  expect(resultSummary("Read", null, "1\n2\n3\n4\n5", false)).toBe("5 lines");
  expect(resultSummary("Bash", null, "only one line", false)).toBe("1 line");
  expect(resultSummary("Bash", null, "", false)).toBe("ok");
  expect(resultSummary("Bash", null, "boom: command not found", true)).toBe("boom: command not found");
  expect(resultSummary("mcp__x__y", null, '{"big":"json"}', false)).toBe("1 line"); // JSON → line count, not raw "{"
});

test("countLines ignores trailing blank", () => {
  expect(countLines("a\nb\n")).toBe(2);
  expect(countLines("")).toBe(0);
});

test("parse folds tool_result into its tool_call (one card, no stray result)", () => {
  const callId = "toolu_123";
  const lines = [
    JSON.stringify({ type: "assistant", uuid: "u1", timestamp: "t1", message: { role: "assistant", content: [{ type: "tool_use", id: callId, name: "Edit", input: { file_path: "/foo.ts", old_string: "a\nb", new_string: "c" } }] } }),
    JSON.stringify({ type: "user", uuid: "u2", timestamp: "t2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, is_error: false, content: "The file /foo.ts has been updated." }] } }),
  ];
  const msgs = parse(lines, 1);
  const calls = msgs.filter((m) => m.kind === "tool_call");
  const strays = msgs.filter((m) => m.kind === "tool_result");
  expect(calls.length).toBe(1);
  expect(strays.length).toBe(0); // result folded into the call, not left dangling
  expect(calls[0]?.done).toBe(true);
  expect(calls[0]?.status).toBe(null);
  expect(calls[0]?.text).toBe("/foo.ts"); // request = file_path
  expect(calls[0]?.result).toBe("+1 −2"); // outcome = diff
  expect(calls[0]?.input).toContain('"file_path": "/foo.ts"'); // full input for expanded card
  expect(calls[0]?.input).toContain('"new_string": "c"');
  expect(calls[0]?.resultText).toBe("The file /foo.ts has been updated."); // full output
});

test("parse leaves a tool_call PENDING when its result hasn't arrived yet", () => {
  const lines = [
    JSON.stringify({ type: "assistant", uuid: "u1", timestamp: "t1", message: { role: "assistant", content: [{ type: "tool_use", id: "tc", name: "Bash", input: { command: "sleep 5", description: "long job" } }] } }),
  ];
  const call = parse(lines, 1).find((m) => m.kind === "tool_call");
  expect(call?.done).toBe(false);
  expect(call?.result).toBe(null);
  expect(call?.input).toContain('"command": "sleep 5"'); // input present even while pending
  expect(call?.resultText).toBe(null); // no output yet
});

test("transcript composition — the counts stats sums (folded result is not a message)", () => {
  const asst = (uuid: string, blocks: unknown[]) =>
    JSON.stringify({ type: "assistant", uuid, timestamp: uuid, message: { role: "assistant", content: blocks } });
  const lines = [
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    asst("a1", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "reply" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    JSON.stringify({ type: "user", uuid: "u2", timestamp: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    asst("a2", [{ type: "text", text: "done" }]),
  ];
  const msgs = parse(lines, 1);
  const count = (pred: (m: (typeof msgs)[number]) => boolean) => msgs.filter(pred).length;
  expect(count((m) => m.kind === "tool_call")).toBe(1);
  expect(count((m) => m.kind === "thinking")).toBe(1);
  expect(count((m) => m.kind === "message" && m.role === "user")).toBe(1);
  expect(count((m) => m.kind === "message" && m.role === "assistant")).toBe(2); // "reply" + "done"
  expect(count((m) => m.kind === "tool_result")).toBe(0); // folded, never double-counted
});

test("parse honors endLine — bounded window for backward pagination", () => {
  const line = (uuid: string, text: string) =>
    JSON.stringify({ type: "assistant", uuid, timestamp: uuid, message: { role: "assistant", content: [{ type: "text", text }] } });
  const lines = [line("u1", "one"), line("u2", "two"), line("u3", "three")];
  const texts = (start: number, endLine?: number) => parse(lines, start, undefined, endLine).map((m) => m.text);
  expect(texts(1)).toEqual(["one", "two", "three"]); // no bound → through end
  expect(texts(1, 2)).toEqual(["one", "two"]); // upper bound drops line 3
  expect(texts(2, 2)).toEqual(["two"]); // a single-line older page [2..2]
});
