import { test, expect } from "bun:test";
import { buildPrompt } from "../src/agent/managePrompt.ts";
import { pickInvocation } from "../src/env.ts";

test("buildPrompt teaches the bare shim invocation (no absolute-path crutch)", () => {
  const p = buildPrompt("cc-x", "ccmux");
  expect(p).toContain("tmux session 'cc-x'");
  expect(p).toContain("ccmux list");
  expect(p).toContain("ccmux new NAME DIR"); // agents need the create trigger
  expect(p).toContain('restart NAME [--then "<note>"]'); // self-restart-and-resume trigger
  expect(p).toContain("this session: cc-x");
  expect(p).toContain("print command output verbatim");
  expect(p).toContain("infer intent");
  // the crutch wording is gone — no "always the absolute invocation above"
  expect(p).not.toContain("absolute invocation");
});

test("buildPrompt falls back cleanly to an absolute invocation when given one", () => {
  const p = buildPrompt("cc-x", "/abs/bun /abs/cli.js");
  expect(p).toContain("/abs/bun /abs/cli.js list");
  expect(p).toContain("/abs/bun /abs/cli.js restart NAME");
});

test("pickInvocation prefers the bare shim, else the absolute invocation", () => {
  expect(pickInvocation(true, "/abs/bun /abs/cli.js")).toBe("ccmux");
  expect(pickInvocation(false, "/abs/bun /abs/cli.js")).toBe("/abs/bun /abs/cli.js");
});

test("buildPrompt adds inter-agent chat framing ONLY when chat is enabled", () => {
  const off = buildPrompt("cc-x", "ccmux");
  expect(off).not.toContain("Inter-agent chat");
  const on = buildPrompt("cc-x", "ccmux", true);
  expect(on).toContain("Inter-agent chat (enabled for this session)");
  expect(on).toContain("ccmux msg <session>");
  expect(on).toContain("PEER AGENT"); // framed as a peer, not the human
  expect(on).toContain("do NOT blindly"); // apply own judgment, not blind obedience
});
