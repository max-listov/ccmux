import { test, expect } from "bun:test";
import { buildPrompt } from "../src/agent/managePrompt.ts";

test("buildPrompt is a stable contract with the in-session claude", () => {
  const p = buildPrompt("cc-x", "/abs/bun /abs/cli.ts");
  expect(p).toContain("tmux session 'cc-x'");
  expect(p).toContain("/abs/bun /abs/cli.ts list");
  expect(p).toContain("/abs/bun /abs/cli.ts new NAME DIR"); // agents need the create trigger
  expect(p).toContain('restart NAME [--then "<note>"]'); // agents need the self-restart-and-resume trigger
  expect(p).toContain("this session: cc-x");
  expect(p).toContain("print command output verbatim");
  expect(p).toContain("infer intent");
});
