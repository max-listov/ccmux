import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
} from 'node:fs';
import type { z } from 'zod';
import { settled, statStamp } from '../util/fileStamp.ts';

const snapshots = new Map<string, { stamp: string; value: unknown }>();
const privateFile = (stat: BigIntStats, maxBytes: number) => {
  const uid = process.getuid?.();
  return (
    stat.isFile() &&
    uid !== undefined &&
    stat.uid === BigInt(uid) &&
    (stat.mode & 0o077n) === 0n &&
    stat.size <= BigInt(maxBytes)
  );
};

/** Private bounded state, never symlinks, devices or shared-writable files. */
export function readPrivateJson<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes = 128 * 1024,
): T | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!privateFile(before, maxBytes)) {
      snapshots.delete(path);
      return null;
    }
    const stamp = statStamp(before);
    const cached = snapshots.get(path);
    if (cached?.stamp === stamp)
      return schema.safeParse(structuredClone(cached.value)).data ?? null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (!privateFile(stat, maxBytes)) return null;
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > maxBytes) return null;
    const value: unknown = JSON.parse(bytes.toString('utf8', 0, size));
    const after = lstatSync(path, { bigint: true });
    if (
      statStamp(fstatSync(fd, { bigint: true })) === stamp &&
      statStamp(after) === stamp &&
      settled(after)
    ) {
      if (snapshots.size >= 256 && !snapshots.has(path)) snapshots.clear();
      snapshots.set(path, { stamp, value });
    }
    return schema.safeParse(structuredClone(value)).data ?? null;
  } catch {
    snapshots.delete(path);
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Create (or accept) a runtime state directory only if it is private: a real directory, owned by the
 *  current user, with no group or world access. Every runtime's private state lives under one. */
export function privateRuntimeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error('Runtime directory must be a private directory owned by the current user');
  }
}
