import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import type { z } from 'zod';

/** Private bounded state, never symlinks, devices or shared-writable files. */
export function readPrivateJson<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes = 128 * 1024,
): T | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > maxBytes
    )
      return null;
    const bytes = Buffer.alloc(maxBytes + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    return size > maxBytes
      ? null
      : (schema.safeParse(JSON.parse(bytes.toString('utf8', 0, size))).data ?? null);
  } catch {
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
