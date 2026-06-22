import { test, expect } from "bun:test";
import { helpText, COMMANDS } from "../src/commands/help.ts";

test("full help lists every public command", () => {
  const t = helpText();
  expect(t).not.toBeNull();
  expect(t).toContain("commands:");
  for (const c of COMMANDS) expect(t).toContain(c.verb);
});

test("per-command help is specific; unknown verb is null", () => {
  const n = helpText("new");
  expect(n).toContain("new <name> <dir>");
  expect(n).toContain("e.g.");
  expect(helpText("bogus")).toBeNull();
});

test("internal verbs are not exposed", () => {
  const verbs = COMMANDS.map((c) => c.verb);
  expect(verbs).not.toContain("_run");
  expect(verbs).not.toContain("daemon");
});
