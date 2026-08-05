import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (f: string): string => readFileSync(join(import.meta.dir, "..", "src", f), "utf8");

/**
 * `_run` shares a terminal with the agent it supervises, so a log line mirrored to stderr prints
 * into that agent's UI and lands in its input buffer — which then trips the "composer occupied"
 * delivery gate and silences the session's chat permanently, blaming a human who isn't there.
 * Proven live before the fix; these guard the shape of the fix rather than re-running a pty.
 */
test("_run silences the stderr log mirror — its stderr is the agent's terminal", () => {
  const s = src("commands/run.ts");
  expect(s).toContain("setStderrLogging(false)");
  // Before the supervisor loop, so nothing inside it can leak, and after argument validation, so a
  // hand-invoked `_run` still complains audibly.
  expect(s.indexOf("setStderrLogging(false)")).toBeLessThan(s.indexOf("for (;;)"));
  expect(s.indexOf("unknown session")).toBeLessThan(s.indexOf("setStderrLogging(false)"));
});

test("a failed spawn still says something in the pane — that is the one case nothing else would", () => {
  const s = src("commands/run.ts");
  expect(s).toContain("could not start");
  // A sentence, not a JSON record: the pane is a human surface.
  expect(s).not.toContain('console.error(JSON');
});

test("the TUI keeps its own mirror off for the same reason — one rule, two callers", () => {
  expect(src("tui/run.tsx")).toContain("setStderrLogging(false)");
});

test("wait treats undelivered mail as work that has not started", () => {
  // The recipe `msg` → `wait` → `transcript` raced itself: the daemon delivers a beat after `msg`
  // returns, so a `wait` fired immediately saw an idle pane and reported a finished turn that had
  // never begun (observed on a live cross-machine hand-off).
  const s = src("commands/wait.ts");
  expect(s).toContain("pendingInbound");
  expect(s).toContain("pendingInbound(m, name).length === 0 && deferReady");
});
