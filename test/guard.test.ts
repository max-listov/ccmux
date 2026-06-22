import { test, expect } from "bun:test";
import { refusesSelf } from "../src/commands/guard.ts";

test("blocks rm/stop of the calling session, allows others + --force override", () => {
  const prev = process.env.CCMUX_SESSION;
  process.env.CCMUX_SESSION = "cc-self";
  try {
    expect(refusesSelf("rm", "cc-self", false)).toBe(true); // self → blocked
    expect(refusesSelf("stop", "cc-self", true)).toBe(false); // --force overrides
    expect(refusesSelf("rm", "cc-other", false)).toBe(false); // other session allowed
  } finally {
    if (prev === undefined) delete process.env.CCMUX_SESSION;
    else process.env.CCMUX_SESSION = prev;
  }
});

test("no-op outside a session (daemon/CLI have no CCMUX_SESSION)", () => {
  const prev = process.env.CCMUX_SESSION;
  delete process.env.CCMUX_SESSION;
  try {
    expect(refusesSelf("rm", "cc-anything", false)).toBe(false);
  } finally {
    if (prev !== undefined) process.env.CCMUX_SESSION = prev;
  }
});
