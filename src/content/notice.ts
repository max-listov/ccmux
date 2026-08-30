import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';

/** The inode stays stable for file watchers. Its bytes carry no state or authority. */
export function contentNotice(path: string, publish: boolean): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 64
    )
      throw new Error('Native content notification file is unsafe');
    if (publish) writeSync(fd, '1', 0, 'utf8');
  } finally {
    closeSync(fd);
  }
}
