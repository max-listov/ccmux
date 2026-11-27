import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workingDirectoryIssue } from '../src/session/workingDirectory.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = realpathSync(mkdtempSync('/tmp/stitchmux-workdir-'));
  roots.push(dir);
  return dir;
}

// Permission bits do not bind root, so the access cases have nothing to prove there.
const asRoot = process.getuid?.() === 0;

test('a usable directory, and one only missing write permission, are not blocked', () => {
  const dir = join(root(), 'ok');
  mkdirSync(dir);
  expect(workingDirectoryIssue('agent-a', dir)).toBeNull();
  chmodSync(dir, 0o500);
  try {
    expect(workingDirectoryIssue('agent-a', dir)).toBeNull();
  } finally {
    chmodSync(dir, 0o700);
  }
});

test.skipIf(asRoot)('a directory the agent cannot enter or list blocks the session', () => {
  const dir = join(root(), 'closed');
  mkdirSync(dir);
  chmodSync(dir, 0o000);
  try {
    expect(workingDirectoryIssue('agent-a', dir)).toContain('is not accessible');
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('missing, non-directory and inaccessible reasons name both repair commands', () => {
  const base = root();
  const file = join(base, 'file');
  writeFileSync(file, '');
  for (const dir of [join(base, 'missing'), file]) {
    const reason = workingDirectoryIssue('agent-a', dir);
    expect(reason).toContain('`stitchmux dir agent-a <path>`');
    expect(reason).toContain('`stitchmux start agent-a`');
  }
});
