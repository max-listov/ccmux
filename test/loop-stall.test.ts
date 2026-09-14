import { expect, test } from 'bun:test';
import { watchLoopStalls } from '../src/daemon/loopStall.ts';

function blockFor(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // hold the event loop, the way a synchronous call does
  }
}

test('a blocked event loop is reported with how long it was blocked', async () => {
  const stalls: number[] = [];
  const stop = watchLoopStalls((blockedMs) => stalls.push(blockedMs), 20, 150);
  try {
    await Bun.sleep(60);
    blockFor(400);
    await Bun.sleep(60);
  } finally {
    stop();
  }
  expect(stalls.length).toBe(1);
  expect(stalls[0]).toBeGreaterThanOrEqual(300);
});

test('a loop that keeps turning reports nothing', async () => {
  const stalls: number[] = [];
  const stop = watchLoopStalls((blockedMs) => stalls.push(blockedMs), 20, 150);
  try {
    await Bun.sleep(200);
  } finally {
    stop();
  }
  expect(stalls).toEqual([]);
});
