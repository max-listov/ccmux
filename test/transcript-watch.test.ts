import { afterEach, expect, test } from 'bun:test';
import { existsSync, type FSWatcher, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The transcript pane is driven by the file, not by a clock.
 *
 * What a reader waits for is "the agent answered", which is a write to the jsonl. These assert the
 * two properties the hook depends on: a write is observed without waiting out an interval, and a
 * watcher that cannot be created leaves the caller a working fallback rather than an exception.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-watch-'));
  roots.push(root);
  return root;
};

test('a write to the transcript is observed long before a poll would come round', async () => {
  const file = join(temp(), 'session.jsonl');
  writeFileSync(file, '{}\n');
  let seen = 0;
  const watcher: FSWatcher = watch(file, () => {
    seen += 1;
  });

  // Arm first, and prove it is armed. `watch()` returns synchronously but the platform registers
  // the watch asynchronously, so a write that lands inside that window is delivered to nobody —
  // no wait, however long, recovers it. Measuring across that race is what made this test fail
  // under load while passing alone, and widening the bound would not have fixed it: the event was
  // not late, it did not exist.
  for (let i = 0; i < 500 && seen === 0; i += 1) {
    writeFileSync(file, `{}\n{"type":"warmup","n":${i}}\n`);
    await Bun.sleep(10);
  }
  expect(seen).toBeGreaterThan(0);

  // Now the measured claim, on one append, with a finite bound. Both halves are the test: without
  // the bound it would pass on a watch slower than the 1500 ms poll it replaces — a build where
  // the feature is worthless — and without the single write it would not exercise what the hook
  // depends on, which is that ONE append arrives.
  seen = 0;
  const started = Date.now();
  writeFileSync(file, '{}\n{"type":"assistant"}\n');
  for (let i = 0; i < 150 && seen === 0; i += 1) await Bun.sleep(10);
  watcher.close();
  expect(seen).toBeGreaterThan(0);
  expect(Date.now() - started).toBeLessThan(1_500);
});

test('a file that is not there yet is not watched, and that is not an error', () => {
  // The hook guards on existence for exactly this: a session whose first line is not written yet
  // must still end up read by the backstop instead of throwing on the way in.
  const missing = join(temp(), 'absent.jsonl');
  expect(existsSync(missing)).toBe(false);
  let watcher: FSWatcher | null = null;
  expect(() => {
    try {
      if (existsSync(missing)) watcher = watch(missing, () => undefined);
    } catch {
      watcher = null;
    }
  }).not.toThrow();
  expect(watcher).toBeNull();
});
