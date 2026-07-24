import { test, expect } from "bun:test";
import { buildPrompt } from "../src/agent/managePrompt.ts";
import { resolvePromptModules, knownPromptModules } from "../src/agent/promptModules.ts";

test("router is a known module; unknown keys fail loud", () => {
  expect(knownPromptModules()).toContain("router");
  expect(() => resolvePromptModules(["router"], { name: "cc-r", cli: "ccmux" })).not.toThrow();
  expect(() => resolvePromptModules(["nope"], { name: "cc-r", cli: "ccmux" })).toThrow(/unknown prompt module 'nope'/);
});

test("the router protocol pins its load-bearing clauses (versioned + testable)", () => {
  const [proto] = resolvePromptModules(["router"], { name: "cc-r", cli: "ccmux" });
  const p = proto ?? "";
  expect(p).toContain("ROUTER MODE");
  expect(p).toContain("ccmux msg <target> --defer --on-behalf-of owner"); // the ONLY delivery path
  expect(p).toContain("when done, report back"); // reply footer
  expect(p).toContain("done-criterion"); // objective validation
  expect(p).toMatch(/at most twice/i); // retry cap
  expect(p).toMatch(/ESCALATE/); // escalation
  expect(p).toMatch(/NEVER message the owner/i); // anti-nag (the whole reason it exists)
  expect(p).toContain("NEVER use `ccmux send`"); // must forbid the interrupting delivery path
});

test("the router protocol teaches the self-watchdog liveness loop", () => {
  const [proto] = resolvePromptModules(["router"], { name: "cc-r", cli: "ccmux" });
  const p = proto ?? "";
  expect(p).toContain("ARM A WATCHDOG"); // the timer that makes it self-driving
  expect(p).toContain("ccmux msg cc-r --after"); // self-ping via time-delayed delivery
  expect(p).toMatch(/re-arm/i); // still-working → re-arm
  expect(p).toMatch(/cap of 3/i); // bounded re-arms, not infinite waiting
  expect(p).toMatch(/idempotent no-op/i); // early report → late watchdog is harmless
  expect(p).toMatch(/didn't report/i); // finished-but-silent is the core gap it closes
});

test("buildPrompt composes the router module INTO one string only when requested", () => {
  const withRouter = buildPrompt("cc-r", "ccmux", true, ["router"]);
  const plain = buildPrompt("cc-r", "ccmux", true, []);
  expect(withRouter).toContain("ROUTER MODE");
  expect(plain).not.toContain("ROUTER MODE");
  // still the base management prompt in both (single injected string, never a competing flag)
  expect(withRouter).toContain("managed by ccmux");
  expect(plain).toContain("managed by ccmux");
});

test("owner-language guidance: mirror by default, explicit override when ownerLang set", () => {
  const mirror = buildPrompt("cc-a", "ccmux", true, []);
  expect(mirror).toContain("Reply to the owner in the same language the owner used.");
  const forced = buildPrompt("cc-a", "ccmux", true, [], "Russian");
  expect(forced).toContain("Reply to the owner in Russian.");
  // language guidance is chat-scoped — absent when chat is off
  expect(buildPrompt("cc-a", "ccmux", false, [])).not.toContain("Reply to the owner");
});
