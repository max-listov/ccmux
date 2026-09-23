import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, copyFileAtomic } from '../src/util/atomic.ts';

// The atomic replace itself is stitchkit's `writeFileAtomic`, tested there. What is ccmux's is what
// its callers rely on around it: a missing parent is created, and a file is private unless a mode
// is stated.
test('an atomic write creates its parent and is private unless a mode is stated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-atomic-'));
  try {
    const nested = join(dir, 'a', 'b', 'state.json');
    await atomicWrite(nested, '{"ok":true}');
    expect(readFileSync(nested, 'utf8')).toBe('{"ok":true}');
    expect(statSync(nested).mode & 0o777).toBe(0o600);
    const shim = join(dir, 'shim');
    await atomicWrite(shim, '#!/bin/sh\n', 0o755);
    expect(statSync(shim).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a write that cannot land leaves no staging file beside its target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-atomic-fail-'));
  try {
    const target = join(dir, 'occupied');
    mkdirSync(target);
    await expect(atomicWrite(target, 'x')).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['occupied']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an atomic copy keeps the bytes and the permission bits of its source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-atomic-copy-'));
  try {
    const from = join(dir, 'ccmux.js.bak');
    const to = join(dir, 'ccmux.js');
    Bun.spawnSync([
      'sh',
      '-c',
      `printf previous > '${from}' && chmod 755 '${from}' && printf broken > '${to}'`,
    ]);
    copyFileAtomic(from, to);
    expect(readFileSync(to, 'utf8')).toBe('previous');
    expect(statSync(to).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir).sort()).toEqual(['ccmux.js', 'ccmux.js.bak']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
