import { expect, test } from "bun:test";
import { signalExitCode } from "../src/commands/daemon.ts";

// Incident 2026-06-11: a neighbor's unscoped `pkill bun` SIGTERMed the daemon; exit 0 +
// KeepAlive SuccessfulExit=false read as "stopped on purpose" → fleet lost self-heal
// silently. Death-by-signal must exit non-zero so launchd/systemd resurrect the daemon.
test("signal exit codes are non-zero (128+signum) so the boot unit resurrects the daemon", () => {
  expect(signalExitCode("SIGTERM")).toBe(143);
  expect(signalExitCode("SIGINT")).toBe(130);
});
