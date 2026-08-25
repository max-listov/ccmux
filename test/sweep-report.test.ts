import { test, expect } from "bun:test";
import { sweepReport, sweepSummary } from "../src/commands/restartAll.ts";

// The sweep is the one command whose caller is dead when it finishes: it restarts the calling session
// LAST, so the result has physically nobody to return to. Measured: an agent swept the fleet and then
// sat silent until a human asked "well?". The fix is NOT the `--then` note that was removed in 0.12.0
// (no sender, no reply address, no ledger entry) — it is a recorded envelope like everything else.

const alive = { known: true, running: true, canChat: true };

test("the caller hears the result, and is told why it arrived as a message", () => {
  const r = sweepReport("host-a", "agent-a", ["agent-b", "agent-a"], null, alive);
  expect(r.recipient).toBe("caller");
  expect(r.body).toContain("2 session(s) restarted");
  expect(r.body).toContain("agent-b, agent-a");
  expect(r.body).toContain("restarted last by that sweep");
});

test("a sweep run outside any session reports to the owner, not into the void", () => {
  // A scheduler or a plain shell has nobody to wake. Dropping the report there is how a sweep becomes
  // "it happens somehow", which is the thing worth avoiding.
  const r = sweepReport("host-a", undefined, ["agent-b"], null, null);
  expect(r.recipient).toBe("owner");
  expect(r.body).not.toContain("could not be told");
});

test("a caller that did NOT come back is named out loud to the owner", () => {
  const r = sweepReport("host-a", "agent-a", ["agent-b", "agent-a"], null, { known: true, running: false, canChat: true });
  expect(r.recipient).toBe("owner");
  expect(r.body).toContain("'agent-a'");
  expect(r.body).toContain("did NOT come back up");
});

test("a caller that cannot receive chat is a different sentence from one that is gone", () => {
  const mute = sweepReport("host-a", "agent-a", ["agent-a"], null, { known: true, running: true, canChat: false });
  expect(mute.body).toContain("cannot receive chat");
  const gone = sweepReport("host-a", "agent-a", ["agent-a"], null, { known: false, running: false, canChat: false });
  expect(gone.body).toContain("no longer in the registry");
});

test("a failed sweep says so, with how far it got", () => {
  const r = sweepReport("host-a", "agent-a", ["agent-b"], "tmux: server not found", alive);
  expect(r.body).toContain("FAILED");
  expect(r.body).toContain("after 1 session(s)");
  expect(r.body).toContain("tmux: server not found");
});

test("the summary names the machine — a fleet operator runs sweeps on more than one", () => {
  expect(sweepSummary("host-b", [], null, undefined)).toContain("on host-b");
});
