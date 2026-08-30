import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
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
