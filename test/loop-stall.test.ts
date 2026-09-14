import { expect, test } from 'bun:test';
import { type LoopStall, watchLoopStalls } from '../src/daemon/loopStall.ts';

function blockFor(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // hold the event loop, the way a synchronous call does
  }
}

async function stallsDuring(run: () => void): Promise<LoopStall[]> {
  const stalls: LoopStall[] = [];
  const stop = watchLoopStalls((stall) => stalls.push(stall), 20, 150);
  try {
    await Bun.sleep(60);
    run();
    await Bun.sleep(60);
  } finally {
    stop();
  }
  return stalls;
}

test('a blocked event loop is reported with how long it was blocked', async () => {
  const stalls = await stallsDuring(() => blockFor(400));
  expect(stalls.length).toBe(1);
  expect(stalls[0]?.blockedMs).toBeGreaterThanOrEqual(300);
});

test('a loop that keeps turning reports nothing', async () => {
  const stalls: LoopStall[] = [];
  const stop = watchLoopStalls((stall) => stalls.push(stall), 20, 150);
  try {
    await Bun.sleep(200);
  } finally {
    stop();
  }
  expect(stalls).toEqual([]);
});

test('a stall spent computing and a stall spent waiting report different CPU time', async () => {
  // The two causes call for opposite fixes, so the report must separate them: work of this
  // process burns CPU for the whole stall, a blocking wait burns almost none.
  const busy = await stallsDuring(() => blockFor(400));
  const waiting = await stallsDuring(() => Bun.sleepSync(400));
  expect(busy.length).toBe(1);
  expect(waiting.length).toBe(1);
  expect(busy[0]?.cpuMs).toBeGreaterThanOrEqual(100);
  expect(waiting[0]?.cpuMs).toBeLessThan(100);
});
