import { expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A filesystem that stalls a rename is not reproducible on demand, so the stall is injected: the
// promise form of `rename` is held open while a timer runs. A write that went back to the sync
// form would never reach this rename, and the timer would not be the thing that measured it.
//
// The mock is process-wide in `bun test` and outlives this file, so it holds only renames into this
// test's own directory. Holding every rename slowed unrelated suites run after it in the same
// process — three context tests failed the full gate that way while passing alone.
const real = await import('node:fs/promises');
// Captured before the mock: the namespace is live, and read afterwards `real.rename` IS the mock.
const realRename = real.rename;
let heldDir: string | null = null;
let held = 0;
mock.module('node:fs/promises', () => ({
  ...real,
  rename: async (from: string, to: string) => {
    if (heldDir !== null && String(to).startsWith(heldDir)) {
      held++;
      await Bun.sleep(150);
    }
    return realRename(from, to);
  },
}));
const { atomicWrite } = await import('../src/util/atomic.ts');

test('an atomic write waits for its rename without holding the event loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-atomic-'));
  heldDir = dir;
  try {
    const path = join(dir, 'state.json');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    await atomicWrite(path, '{"ok":true}', 0o600);
    clearInterval(timer);
    expect(held).toBe(1);
    expect(ticks).toBeGreaterThanOrEqual(5);
    expect(readFileSync(path, 'utf8')).toBe('{"ok":true}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
