import { test, expect } from "bun:test";
import { helpText, usageLine } from "../src/commands/help.ts";

test("msg --help and the arg-error usage share ONE source (all flags visible)", () => {
  const help = helpText("msg") ?? "";
  const usage = usageLine("msg");
  // the exact 0.1.16 defect: --help must no longer hide the flags the error text showed
  for (const flag of ["--task", "--defer", "--after", "--on-behalf-of", "cancel"]) {
    expect(help).toContain(flag);
    expect(usage).toContain(flag);
  }
  // usage carries the sender-is-automatic note
  expect(usage).toContain("sender is automatic");
});

test("usageLine is derived per verb; unknown verb degrades gracefully", () => {
  expect(usageLine("send")).toContain("usage: ccmux send");
  expect(usageLine("does-not-exist")).toBe("usage: ccmux does-not-exist");
});

test("inbox help documents that it is a fallback, not an archive", () => {
  expect(helpText("inbox") ?? "").toMatch(/fallback|not an archive/i);
});
