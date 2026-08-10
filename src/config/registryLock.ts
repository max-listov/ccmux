import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { z } from "zod";
import type { MachineConfig } from "../types.ts";
import { sessionRegistryLockPath } from "./paths.ts";

const WAIT_MS = 20;
const TIMEOUT_MS = 10_000;
const STALE_MS = 30_000;
const LockOwnerSchema = z.object({ pid: z.number().int().positive(), token: z.uuid() });

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

function reapDeadLock(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= STALE_MS) return;
    const path = ownerPath(lock);
    if (existsSync(path)) {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      const owner = LockOwnerSchema.parse(value);
      if (processAlive(owner.pid)) return;
      unlinkSync(path);
    }
    rmdirSync(lock);
  } catch {
    // The holder released it, or another waiter completed the dead-owner reap.
  }
}

/** Serialize every sessions/pending read-modify-write transaction across ccmux processes. */
export async function withSessionRegistryLock<T>(m: MachineConfig, run: () => Promise<T>): Promise<T> {
  const lock = sessionRegistryLockPath(m);
  const token = randomUUID();
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(ownerPath(lock), `${JSON.stringify({ pid: process.pid, token })}\n`, { mode: 0o600 });
      break;
    } catch {
      reapDeadLock(lock);
      if (Date.now() >= deadline) throw new Error("session registry lock timed out");
      await Bun.sleep(WAIT_MS);
    }
  }
  try {
    return await run();
  } finally {
    try {
      const value: unknown = JSON.parse(readFileSync(ownerPath(lock), "utf8"));
      const owner = LockOwnerSchema.parse(value);
      if (owner.token === token && owner.pid === process.pid) {
        unlinkSync(ownerPath(lock));
        rmdirSync(lock);
      }
    } catch {
      // A missing lock means this owner no longer owns anything to release.
    }
  }
}
