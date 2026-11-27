import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { HOME } from '../util/home.ts';
import { log } from '../util/log.ts';
import {
  type ControlDirectoryReadSchema,
  type ControlDirectoryResult,
  ControlDirectoryResultSchema,
} from './schema/directory.ts';
import { refusals } from './schema/refusals.ts';

const CursorSchema = z
  .object({ path: z.string(), version: z.string(), after: z.string(), hidden: z.boolean() })
  .strict();
type Entry = ControlDirectoryResult['entries'][number];
const identity = (stat: Awaited<ReturnType<typeof lstat>>): string =>
  [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs].join(':');
// The listing itself is part of the version: a directory's mtime comes from the kernel's coarse
// clock, so an entry added within the same tick as the previous change leaves the stat unchanged.
const version = (stat: string, names: [string, Entry['kind']][]): string =>
  createHash('sha256')
    .update(JSON.stringify([stat, names.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]))
    .digest('hex');

async function directoryStat(path: string) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw refusals.errors.SYMLINK_REFUSED({ message: 'Directory symlinks are not followed' });
    if (!stat.isDirectory())
      throw refusals.errors.NOT_A_DIRECTORY({ message: 'Requested entry is not a directory' });
  }
  return lstat(path);
}

/** Names-only, versioned directory pages. Changed directories explicitly invalidate pagination. */
export async function readControlDirectory(
  input: z.output<typeof ControlDirectoryReadSchema>,
  signal: AbortSignal,
): Promise<ControlDirectoryResult> {
  const path = resolve(input.path ?? HOME);
  try {
    signal.throwIfAborted();
    const stat = identity(await directoryStat(path));
    let cursor: z.infer<typeof CursorSchema> | null = null;
    if (input.cursor !== null) {
      try {
        cursor = CursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')),
        );
      } catch {
        throw refusals.errors.INVALID_CURSOR({ message: 'Directory cursor is invalid' });
      }
    }
    const after = cursor?.after ?? '';
    const entries: Entry[] = [];
    const names: [string, Entry['kind']][] = [];
    let scanned = 0;
    const directory = await opendir(path);
    for await (const item of directory) {
      signal.throwIfAborted();
      if (++scanned > 20_000)
        throw refusals.errors.DIRECTORY_TOO_LARGE({ message: 'Directory exceeds listing budget' });
      const kind = item.isSymbolicLink()
        ? 'symlink'
        : item.isDirectory()
          ? 'dir'
          : item.isFile()
            ? 'file'
            : 'other';
      names.push([item.name, kind]);
      if ((!input.includeHidden && item.name.startsWith('.')) || item.name <= after) continue;
      entries.push({ name: item.name, path: join(path, item.name), kind });
    }
    const stamp = version(stat, names);
    if (
      identity(await directoryStat(path)) !== stat ||
      (cursor !== null &&
        (cursor.path !== path || cursor.hidden !== input.includeHidden || cursor.version !== stamp))
    )
      throw refusals.errors.STALE_CURSOR({ message: 'Directory changed; restart listing' });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const page: ControlDirectoryResult['entries'] = [];
    let bytes = 0;
    for (const item of entries.slice(0, input.limit)) {
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > 240 * 1024) break;
      page.push(item);
    }
    const last = page.at(-1);
    return ControlDirectoryResultSchema.parse({
      path,
      parent: dirname(path) === path ? null : dirname(path),
      entries: page,
      nextCursor:
        last !== undefined && page.length < entries.length
          ? Buffer.from(
              JSON.stringify({
                path,
                version: stamp,
                after: last.name,
                hidden: input.includeHidden,
              }),
            ).toString('base64url')
          : null,
    });
  } catch (error) {
    if (error instanceof AppError || signal.aborted) throw error;
    log.error({ msg: 'directory listing failed', path, reason: String(error) });
    const code = error instanceof Error && 'code' in error ? error.code : null;
    if (code === 'ENOENT') throw refusals.errors.NOT_FOUND({ message: 'Directory was not found' });
    if (code === 'ENOTDIR')
      throw refusals.errors.NOT_A_DIRECTORY({ message: 'Requested entry is not a directory' });
    if (code === 'EACCES' || code === 'EPERM')
      throw refusals.errors.PERMISSION_DENIED({ message: 'Directory is not accessible' });
    throw refusals.errors.UNAVAILABLE({ message: 'Directory listing is unavailable' });
  }
}
