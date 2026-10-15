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
import { AppError } from 'stitchkit';
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
function readPrivateJsonState<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes = 128 * 1024,
): { status: 'value'; value: T } | { status: 'missing' | 'invalid' } {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!privateFile(before, maxBytes)) {
      snapshots.delete(path);
      return { status: 'invalid' };
    }
    const stamp = statStamp(before);
    const cached = snapshots.get(path);
    if (cached?.stamp === stamp) return parsedState(schema, cached.value);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (!privateFile(stat, maxBytes)) return { status: 'invalid' };
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > maxBytes) return { status: 'invalid' };
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
    return parsedState(schema, value);
  } catch (error) {
    snapshots.delete(path);
    return {
      status:
        error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
          ? 'missing'
          : 'invalid',
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parsedState<T>(
  schema: z.ZodType<T>,
  value: unknown,
): { status: 'value'; value: T } | { status: 'invalid' } {
  const parsed = schema.safeParse(structuredClone(value));
  return parsed.success ? { status: 'value', value: parsed.data } : { status: 'invalid' };
}
export function readPrivateJson<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes = 128 * 1024,
): T | null {
  const result = readPrivateJsonState(path, schema, maxBytes);
  return result.status === 'value' ? result.value : null;
}
/** Missing and invalid are distinguished by the same read, without an exists-after-read race. */
export function readPrivateJournal<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes = 128 * 1024,
): T | null {
  const result = readPrivateJsonState(path, schema, maxBytes);
  if (result.status === 'invalid')
    throw new AppError('CORRUPT_STATE', { message: 'Private journal is unreadable', status: 503 });
  return result.status === 'value' ? result.value : null;
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
