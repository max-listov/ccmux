import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRegistryLockPath } from "../src/config/paths.ts";
import { TIMEOUT_MS, UNCLAIMED_GRACE_MS, lockVerdict, withSessionRegistryLock } from "../src/config/registryLock.ts";
import { makeMachine } from "./helpers.ts";

// Which evidence decides is the whole of this. Death is proven by the PID; age proves nothing about
// a process. Asking age first is what made a lock abandoned one second ago outlive every caller:
// measured before this, a waiter spent its full ten-second deadline in front of a holder that
// `process.kill(pid, 0)` would have called dead immediately.

const DEAD_PID = 2_147_483_647;
const TOKEN = "11111111-1111-4111-8111-111111111111";
const dead = () => false;
const alive = () => true;

function held(stateDir: string, pid: number): string {
  const lock = sessionRegistryLockPath(makeMachine({ stateDir }));
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid, token: TOKEN })}\n`);
  return lock;
}

function withTempState<T>(run: (stateDir: string) => T): T {
  const stateDir = mkdtempSync(join(tmpdir(), "ccmux-registry-lock-"));
  try {
    return run(stateDir);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("a dead owner is reaped AT ANY AGE — the pid is the evidence, not the clock", async () => {
  // The defect this replaces, as a measurement: a lock abandoned a moment ago by a process that had
  // died took the full timeout and then failed, because the reap was gated on an age the waiter
  // could never outlive. Nothing here backdates anything.
  await withTempState(async (stateDir) => {
    const machine = makeMachine({ stateDir });
    held(stateDir, DEAD_PID);
    const started = Date.now();
    await expect(withSessionRegistryLock(machine, async () => "recovered")).resolves.toBe("recovered");
    expect(Date.now() - started).toBeLessThan(1_000);
    // …and the lock is usable again afterwards, not merely survivable once.
    await expect(withSessionRegistryLock(machine, async () => "reused")).resolves.toBe("reused");
  });
});

test("the grace must stay shorter than the wait, or the reap is unreachable", () => {
  // The bug, stated as the relationship that caused it. The two numbers were 30s and 10s: every
  // waiter gave up before it was allowed to clean anything, so an abandoned lock was cleared not by
  // the mechanism but by whoever happened to arrive late. An edit that inverts these again fails
  // here rather than in production.
  expect(UNCLAIMED_GRACE_MS).toBeLessThan(TIMEOUT_MS);
});

test("a LIVE owner is never taken, however old the lock is", () => {
  // The property the age gate was protecting, kept — and now expressed against the thing that
  // actually decides. An hour-old lock held by a running process is still that process's.
  const hourOld = 60 * 60_000;
  expect(lockVerdict(hourOld, 0, { pid: 1234, token: TOKEN }, alive)).toEqual({ kind: "held", pid: 1234 });
});

test("a dead owner is reapable immediately, and the verdict says why", () => {
  const v = lockVerdict(1_000, 999, { pid: 4242, token: TOKEN }, dead);
  expect(v.kind).toBe("reap");
  expect(v).toMatchObject({ why: "owner pid 4242 is gone" });
});

test("a directory with no owner yet is left alone — a claim takes two syscalls", () => {
  // Between creating the directory and writing the owner file there is a window, and a waiter
  // arriving inside it must not tear down a lock somebody is in the middle of taking.
  expect(lockVerdict(1_000, 900, null, dead)).toMatchObject({ kind: "wait" });
});

test("a directory that NEVER got an owner is a wreck, and is cleared", () => {
  // The other half of the same shape: `mkdir` succeeded and the owner write did not, so nobody owns
  // this and nothing will ever come to claim it. Only age separates the two cases, which is the one
  // question age is asked.
  expect(lockVerdict(60_000, 0, null, dead)).toMatchObject({ kind: "reap", why: "no owner was ever recorded" });
});

test("an unreadable owner is treated as absent, never as permission", () => {
  // Not evidence of death, and not evidence of life. It falls into the age question like any other
  // unclaimed directory rather than granting a takeover.
  expect(lockVerdict(1_000, 900, null, alive)).toMatchObject({ kind: "wait" });
});

test("a lock whose creator failed to claim it does not wedge the next caller", async () => {
  // Reproduces the leak directly: a bare directory, no owner file, as if a process had created it
  // and died before writing. Aged past the grace, the next caller clears it instead of waiting out
  // its whole deadline.
  await withTempState(async (stateDir) => {
    const machine = makeMachine({ stateDir });
    const lock = sessionRegistryLockPath(machine);
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const started = Date.now();
    await expect(withSessionRegistryLock(machine, async () => "took it")).resolves.toBe("took it");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

test("the lock is released when the transaction throws, not only when it returns", async () => {
  await withTempState(async (stateDir) => {
    const machine = makeMachine({ stateDir });
    await expect(withSessionRegistryLock(machine, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(existsSync(sessionRegistryLockPath(machine))).toBe(false);
    await expect(withSessionRegistryLock(machine, async () => "next")).resolves.toBe("next");
  });
});
