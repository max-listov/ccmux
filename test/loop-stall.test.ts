import { expect, test } from 'bun:test';
import { type LoopStall, watchLoopStalls } from '../src/daemon/loopStall.ts';

function blockFor(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // hold the event loop, the way a synchronous call does
  }
}

/**
 * Hold the loop until this process has spent `ms` of CPU. Bounded by CPU rather than by the clock:
 * on a loaded host a spin bounded by wall time is descheduled for part of it, and the CPU it is
 * charged then measures the host, not the detector. One thread cannot spend 400 ms of CPU in less
 * than 400 ms of wall time, so the stall is still at least that long.
 */
function burnCpu(ms: number): void {
  const start = process.cpuUsage();
  const ceiling = performance.now() + 10_000;
  while (performance.now() < ceiling) {
    const spent = process.cpuUsage(start);
    if ((spent.user + spent.system) / 1_000 >= ms) return;
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

test('a stall reports the page faults and preemptions of its own window, not the totals', async () => {
  // A paged-out process and a starved one both burn no CPU; the counters tell them apart, and only
  // their growth across the stall says anything about it.
  let current = { cpuMicros: 5_000_000, majorFaults: 900, preemptions: 70_000 };
  const stalls: LoopStall[] = [];
  const stop = watchLoopStalls(
    (stall) => stalls.push(stall),
    20,
    150,
    () => current,
  );
  try {
    await Bun.sleep(60);
    blockFor(300);
    current = { cpuMicros: 5_040_000, majorFaults: 912, preemptions: 70_450 };
    await Bun.sleep(60);
  } finally {
    stop();
  }
  expect(stalls.length).toBe(1);
  expect(stalls[0]).toMatchObject({ cpuMs: 40, majorFaults: 12, preemptions: 450 });
});

test('a stall spent computing and a stall spent waiting report different CPU time', async () => {
  // The two causes call for opposite fixes, so the report must separate them: work of this
  // process burns CPU for the whole stall, a blocking wait burns almost none.
  const busy = await stallsDuring(() => burnCpu(400));
  const waiting = await stallsDuring(() => Bun.sleepSync(400));
  expect(busy.length).toBe(1);
  expect(waiting.length).toBe(1);
  expect(busy[0]?.cpuMs).toBeGreaterThanOrEqual(300);
  expect(waiting[0]?.cpuMs).toBeLessThan(100);
});
