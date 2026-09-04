import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { WatchListener } from 'node:fs';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeWake } from '../src/runtime/wake.ts';

class TestWatcher extends EventEmitter {
  close() {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

test('a coalesced event naming a lock still detects the changed command', async () => {
  const root = mkdtempSync('/tmp/ccmux-wake-coalesced-');
  const command = join(root, 'input.json');
  let event: WatchListener<string> = () => {
    throw new Error('watcher not registered');
  };
  const wake = new RuntimeWake([command], new AbortController().signal, (_path, listener) => {
    event = listener;
    return new TestWatcher();
  });
  try {
    const waiting = wake.wait(60_000);
    writeFileSync(command, '{}');
    // The OS delivers no command filename at all, only the neighbour in the same batch.
    event('rename', 'history-reader.lock');
    await waiting;
  } finally {
    wake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('wake retains changes during work and cancellation releases an idle owner', async () => {
  const abort = new AbortController();
  const wake = new RuntimeWake([], abort.signal);
  try {
    wake.notify();
    await wake.wait(60_000);
    const waiting = wake.wait(60_000);
    abort.abort();
    await waiting;
    await wake.wait(60_000);
  } finally {
    wake.close();
  }
});

test('atomic command replacement wakes before reconciliation; producer outputs do not', async () => {
  const root = mkdtempSync('/tmp/ccmux-wake-');
  const command = join(root, 'input.json');
  const abort = new AbortController();
  const wake = new RuntimeWake([command], abort.signal);
  let changed = false;
  let completed = false;
  let writer: ReturnType<typeof setInterval> | undefined;
  try {
    const waiting = wake.wait(60_000).then(() => {
      completed = true;
      expect(changed).toBe(true);
    });
    writeFileSync(join(root, 'status.json'), '{}');
    writeFileSync(join(root, 'status.json.tmp-1'), '{}');
    await Bun.sleep(30);
    expect(completed).toBe(false);
    changed = true;
    // Repeat the stimulus across watcher registration, never depend on a startup sleep.
    writer = setInterval(() => {
      writeFileSync(join(root, 'history-reader.lock'), '{}');
      writeFileSync(join(root, 'input.json.tmp-1'), '{}');
      renameSync(join(root, 'input.json.tmp-1'), command);
    }, 20);
    await waiting;
  } finally {
    clearInterval(writer);
    wake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing watcher still reconciles and cannot strand commands', async () => {
  const wake = new RuntimeWake(
    ['/nonexistent/ccmux-wake/input.json'],
    new AbortController().signal,
  );
  try {
    await wake.wait(20);
  } finally {
    wake.close();
  }
});
