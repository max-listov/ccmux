import { test, expect } from "bun:test";
import { buildPrompt } from "../src/agent/managePrompt.ts";
import { pickInvocation } from "../src/env.ts";

test("buildPrompt teaches the bare shim invocation (no absolute-path crutch)", () => {
  const p = buildPrompt("cc-x", "ccmux", "claude", "ccmux");
  expect(p).toContain("session 'cc-x'");
  expect(p).toContain("ccmux list");
  expect(p).toContain("ccmux new NAME DIR"); // agents need the create trigger
  expect(p).toContain("ccmux restart NAME");
  expect(p).toContain("use msg for any hand-off");
  expect(p).toContain("this session: cc-x");
  expect(p).toContain("print command output verbatim");
  expect(p).toContain("infer intent");
  // the crutch wording is gone — no "always the absolute invocation above"
  expect(p).not.toContain("absolute invocation");
});

test("buildPrompt falls back cleanly to an absolute invocation when given one", () => {
  const p = buildPrompt("cc-x", "/abs/bun /abs/cli.js", "claude", "ccmux");
  expect(p).toContain("/abs/bun /abs/cli.js list");
  expect(p).toContain("/abs/bun /abs/cli.js restart NAME");
});

test("buildPrompt pins provider/source/address and keeps Desktop native routing separate", () => {
  const p = buildPrompt("agent-a", "ccmux", "codex", "ccmux", false, [], undefined, "host-a");
  expect(p).toContain("provider=codex, source=ccmux, plane=ccmux-managed, address=host-a:agent-a");
  expect(p).toContain("desktop-native plane");
  expect(p).toContain("does not mirror or duplicate");
  expect(p).toContain("Never choose between Desktop-native and ccmux-managed by cwd/project");
});

test("pickInvocation prefers the bare shim, else the absolute invocation", () => {
  expect(pickInvocation(true, "/abs/bun /abs/cli.js")).toBe("ccmux");
  expect(pickInvocation(false, "/abs/bun /abs/cli.js")).toBe("/abs/bun /abs/cli.js");
});

test("buildPrompt adds inter-agent chat framing ONLY when chat is enabled", () => {
  const off = buildPrompt("cc-x", "ccmux", "claude", "ccmux");
  expect(off).not.toContain("Inter-agent chat");
  const on = buildPrompt("cc-x", "ccmux", "claude", "ccmux", true);
  expect(on).toContain("Inter-agent chat (enabled for this session)");
  expect(on).toContain("ccmux msg <session>");
  expect(on).toContain("PEER AGENT"); // framed as a peer, not the human
  expect(on).toContain("do NOT blindly"); // apply own judgment, not blind obedience
});

test("every hand-off example is ADDRESSED — the omission that made the first version useless", () => {
  // The first version said `wait <session>` and left `<machine>:<session>` in a different block, so a
  // cross-machine hand-off required the agent to join two halves itself. It didn't: 1m51s after
  // restarting onto that prompt it wrapped everything in ssh instead. Addresses now appear in the
  // examples themselves.
  const p = buildPrompt("cc-x", "ccmux", "claude", "ccmux");
  expect(p).toContain("ccmux msg <machine>:<session>");
  expect(p).toContain("ccmux wait <machine>:<session>");
  expect(p).toContain("ccmux transcript <machine>:<session> --last-message");
  expect(p).toContain("ccmux fleet"); // how to discover an address in the first place
});

test("the ssh wrapper is banned WITH its consequence, not just forbidden", () => {
  const p = buildPrompt("cc-x", "ccmux", "claude", "ccmux");
  expect(p).toContain("NEVER wrap these in ssh");
  // The reason is the load-bearing part: an unattributed message reads as the human.
  expect(p).toContain("as coming from the human, not from you");
});

test("the polling ban names the SUBSTANCE, not one shape of loop", () => {
  // The previous wording banned "sleep + ccmux list + grep/awk". The agent polled a DATABASE, which
  // that sentence does not cover — so it read the ban literally and complied with it while doing
  // exactly the forbidden thing.
  const p = buildPrompt("cc-x", "ccmux", "claude", "ccmux");
  expect(p).toContain("by polling ANYTHING");
  for (const shape of ["not the pane", "not a database", "not files", "not sizes"]) expect(p).toContain(shape);
  expect(p).toContain("idle BETWEEN steps"); // the reason, not just the ban
});

test("the recipe lives in ONE place — the chat block no longer restates it", () => {
  const p = buildPrompt("cc-x", "ccmux", "claude", "ccmux", true);
  expect(p).not.toContain("Handing work off:");
  expect(p.split("ccmux wait <machine>:<session>")).toHaveLength(2); // stated exactly once
});
