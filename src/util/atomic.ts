import { renameSync, chmodSync } from "node:fs";

/**
 * Write a file atomically: write to a unique temp sibling, then rename over the
 * target. A half-write can never be observed as the live file (used for the
 * sessions file, machine.json, boot units, and the update swap).
 */
export async function atomicWrite(path: string, text: string, mode?: number): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, text);
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path); // atomic on the same filesystem
}
