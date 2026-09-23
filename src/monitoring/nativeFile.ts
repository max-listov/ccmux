import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { MonitoringRead } from './schema.ts';

export class MonitoringFileError extends Error {
  constructor(readonly reason: NonNullable<MonitoringRead['reason']>) {
    super(reason);
  }
}

/** Local same-user regular files only. A stuck filesystem can hold just one bounded read. */
export async function readBoundedFile(path: string, limit: number): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    throw new MonitoringFileError(
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? 'missing'
        : 'read-failed',
    );
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new MonitoringFileError('invalid');
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
      throw new MonitoringFileError('unauthorized');
    if (stat.size > limit) throw new MonitoringFileError('oversized');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new MonitoringFileError('oversized');
    return bytes.toString('utf8', 0, length);
  } finally {
    await file.close();
  }
}
