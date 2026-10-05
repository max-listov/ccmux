import { expect, test } from 'bun:test';
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStamp } from '../src/util/fileStamp.ts';

test('a stamp follows a symlink by default, stamps the link itself when asked, and names absence', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-file-stamp-'));
  try {
    const target = join(root, 'target');
    const link = join(root, 'link');
    writeFileSync(target, 'one');
    symlinkSync(target, link);
    const followed = fileStamp(link);
    const own = fileStamp(link, { follow: false });
    expect(followed).toBe(fileStamp(target));
    expect(own).not.toBe(followed);
    writeFileSync(target, 'longer content');
    // The target changed: the followed stamp moves, the link's own stamp does not.
    expect(fileStamp(link)).not.toBe(followed);
    expect(fileStamp(link, { follow: false })).toBe(own);
    // An atomic replacement keeps the size and the name but not the inode.
    const before = fileStamp(target);
    writeFileSync(join(root, 'next'), 'longer content');
    renameSync(join(root, 'next'), target);
    expect(fileStamp(target)).not.toBe(before);
    expect(fileStamp(join(root, 'absent'))).toBe('missing');
    rmSync(target);
    expect(fileStamp(link)).toBe('missing');
    expect(fileStamp(link, { follow: false })).not.toBe('missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
