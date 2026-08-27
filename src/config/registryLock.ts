import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { z } from "zod";
import type { MachineConfig } from "../types.ts";
import { sessionRegistryLockPath } from "./paths.ts";

const WAIT_MS = 20;
/** How long a caller waits for the lock before giving up. */
export const TIMEOUT_MS = 10_000;
/**
 * Grace for a lock directory that carries no readable owner — and ONLY for that case.
 *
 * There is a window of two syscalls between creating the directory and writing the owner file, and
 * a waiter that arrives inside it must not tear down a lock somebody is in the middle of taking.
 * Age is the only thing that separates that instant from a directory whose creator died between the
 * two, so age governs here and nowhere else.
 *
 * ⚠️ It MUST stay below `TIMEOUT_MS`. A grace longer than the wait makes the reap unreachable: every
 * waiter gives up before it is allowed to clean anything, so an abandoned lock is cleared not by the
 * mechanism but by whoever happens to arrive late. That is precisely the shape this replaces, where
 * the two numbers were 30s and 10s.
 */
export const UNCLAIMED_GRACE_MS = 5_000;

const LockOwnerSchema = z.object({ pid: z.number().int().positive(), token: z.uuid() });
type LockOwner = z.infer<typeof LockOwnerSchema>;

function ownerPath(lock: string): string {
  return join(lock, "owner.json");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** What a waiter should do about the lock it just found. */
export type LockVerdict =
  | { kind: "held"; pid: number }
  | { kind: "reap"; why: string }
  | { kind: "wait"; why: string };

/**
 * Pure: facts about the lock → what to do about it.
 *
 * The rule that matters is which evidence decides. **Death is proven by the pid**, and a dead
 * owner's lock is reapable the instant it is seen, at any age. Age proves nothing about a process
 * and was never the right question — asking it first is what made a lock abandoned one second ago
 * outlive every caller: measured, a waiter spent its whole 10-second deadline in front of a holder
 * that `process.kill(pid, 0)` would have called dead immediately.
 *
 * Age answers exactly one question — whether a directory with no readable owner is a claim in
 * flight or the wreck of one — and it is asked only there.
 */
export function lockVerdict(
  nowMs: number,
  mtimeMs: number,
  owner: LockOwner | null,
  alive: (pid: number) => boolean = processAlive,
): LockVerdict {
  if (owner !== null) {
    return alive(owner.pid)
      ? { kind: "held", pid: owner.pid }
      : { kind: "reap", why: `owner pid ${owner.pid} is gone` };
  }
  // No owner, or one we cannot read. Unreadable is not evidence of anything, so it is treated the
  // same as absent rather than as permission to take the lock.
  return nowMs - mtimeMs <= UNCLAIMED_GRACE_MS
    ? { kind: "wait", why: "a claim may be in flight" }
    : { kind: "reap", why: "no owner was ever recorded" };
}

function readOwner(lock: string): LockOwner | null {
  try {
    const path = ownerPath(lock);
    if (!existsSync(path)) return null;
    return LockOwnerSchema.safeParse(JSON.parse(readFileSync(path, "utf8"))).data ?? null;
  } catch {
    return null;
  }
}

/** Look at the lock; clear it when the verdict says so. Returns the verdict, so a waiter that gives
 *  up can say what it was actually waiting for instead of only that it waited. */
function inspectAndReap(lock: string): LockVerdict {
  let verdict: LockVerdict;
  try {
    verdict = lockVerdict(Date.now(), statSync(lock).mtimeMs, readOwner(lock));
  } catch {
    return { kind: "wait", why: "the lock vanished while being examined" };
  }
  if (verdict.kind !== "reap") return verdict;
  try {
    unlinkSync(ownerPath(lock));
  } catch {
    // Already gone — the file may never have existed, which is one of the two reap cases.
  }
  try {
    rmdirSync(lock);
  } catch {
    // The holder released it, or another waiter completed the same reap.
  }
  return verdict;
}

/** Serialize every sessions/pending read-modify-write transaction across ccmux processes. */
export async function withSessionRegistryLock<T>(m: MachineConfig, run: () => Promise<T>): Promise<T> {
  return withDirectoryLock(sessionRegistryLockPath(m), run, "session registry");
}

/** The same owner-aware exclusion for a fixed, caller-owned filesystem resource. */
export async function withDirectoryLock<T>(lock: string, run: () => Promise<T>, label = "directory"): Promise<T> {
  const token = randomUUID();
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + TIMEOUT_MS;
  let last: LockVerdict = { kind: "wait", why: "not yet examined" };
  for (;;) {
    let created = false;
    try {
      mkdirSync(lock, { mode: 0o700 });
      created = true;
      writeFileSync(ownerPath(lock), `${JSON.stringify({ pid: process.pid, token })}\n`, { mode: 0o600 });
      break;
    } catch {
      // A directory this process created but could not claim is its own wreck, and it is cleared
      // HERE rather than left for the grace period to notice. Leaving it would block every caller —
      // including this one, on its very next attempt — over a failure that is already known about.
      if (created) {
        try {
          rmdirSync(lock);
        } catch {
          // best-effort; the unclaimed grace covers what could not be removed
        }
      } else {
        last = inspectAndReap(lock);
      }
      if (Date.now() >= deadline) {
        // Say what was in the way. A bare "timed out" sent a reader looking for contention that did
        // not exist; the pid of a live holder, or the absence of one, is the first thing to know.
        const detail = last.kind === "held" ? `held by pid ${last.pid}` : last.why;
        throw new Error(label + " lock timed out after " + TIMEOUT_MS + "ms (" + detail + ")");
      }
      await Bun.sleep(WAIT_MS);
    }
  }
  try {
    return await run();
  } finally {
    try {
      const owner = readOwner(lock);
      if (owner !== null && owner.token === token && owner.pid === process.pid) {
        unlinkSync(ownerPath(lock));
        rmdirSync(lock);
      }
    } catch {
      // A missing lock means this owner no longer owns anything to release.
    }
  }
}
