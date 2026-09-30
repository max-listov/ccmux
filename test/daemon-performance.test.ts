import { expect, test } from 'bun:test';
import { watchLoopStalls } from '../src/daemon/loopStall.ts';
import { DaemonPerformance } from '../src/monitoring/performance.ts';
import { measureCpu } from '../src/util/cpuScope.ts';

function busy(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) Math.sqrt(Math.random());
}

test('callback CPU is counted once across overlapping async scopes and synchronous nested work', async () => {
  const profile = new DaemonPerformance();
  profile.start();
  try {
    await Promise.all([
      profile.run('schedule/a', async () => {
        busy(15);
        await Bun.sleep(5);
        measureCpu(() => busy(15));
      }),
      profile.run('control/b', async () => {
        busy(15);
        await Bun.sleep(1);
        profile.run('control/nested', () => busy(15));
      }),
    ]);
    const result = profile.snapshot();
    const total = result.cpu.userUs + result.cpu.systemUs;
    const counted = result.scopes.reduce(
      (sum, row) => sum + (row.cpu?.userUs ?? 0) + (row.cpu?.systemUs ?? 0),
      0,
    );
    expect(total).toBeGreaterThan(20_000);
    expect(counted).toBeLessThanOrEqual(total + 100);
    expect(counted / total).toBeGreaterThan(0.8);
    for (const scope of result.scopes) {
      expect(scope.active).toBe(0);
      expect(scope.runs).toBe(1);
      expect((scope.cpu?.userUs ?? 0) + (scope.cpu?.systemUs ?? 0)).toBeGreaterThan(3_000);
    }
    expect(profile.stallWork().recent?.name).toBeString();
    // Negative control: work outside a measured operation stays explicitly unattributed.
    const before = result.unattributed.userUs + result.unattributed.systemUs;
    busy(20);
    const after = profile.snapshot();
    expect(after.unattributed.userUs + after.unattributed.systemUs - before).toBeGreaterThan(8_000);
    expect(() =>
      profile.run('control/refused', () => {
        throw new Error('refused');
      }),
    ).toThrow('refused');
    expect(profile.snapshot().scopes.find((row) => row.name === 'control/refused')?.failures).toBe(
      1,
    );
  } finally {
    profile.close();
  }
});

test('a real stalled timer retains the blocking operation even after a fast pass finishes', async () => {
  const profile = new DaemonPerformance();
  let blocker: string | undefined;
  const stop = watchLoopStalls(
    () => {
      blocker = profile.stallWork().recentSync?.name;
    },
    10,
    30,
  );
  try {
    await Bun.sleep(20);
    profile.run('schedule/blocker', () => busy(80));
    profile.run('schedule/fast', () => 1);
    await Bun.sleep(20);
    expect(blocker).toBe('schedule/blocker');
    expect(
      profile.snapshot().scopes.find((row) => row.name === 'schedule/blocker')?.durationMs,
    ).toBeGreaterThanOrEqual(80);
  } finally {
    stop();
    profile.close();
  }
});

test('a blocked synchronous operation identifies itself while active and after completion', () => {
  const profile = new DaemonPerformance();
  profile.start();
  try {
    profile.run('schedule/slow', () => {
      busy(10);
      expect(profile.stallWork().active).toEqual(['schedule/slow']);
    });
    expect(profile.stallWork().recent?.name).toBe('schedule/slow');
    expect(profile.snapshot().scopes[0]?.durationMs).toBeGreaterThanOrEqual(10);
  } finally {
    profile.close();
  }
});

test('CPU tracing can change epochs during pending work without charging the retired epoch', async () => {
  const profile = new DaemonPerformance();
  profile.start(false);
  const pending = profile.run('schedule/old', async () => {
    await Bun.sleep(10);
    measureCpu(() => busy(5));
  });
  expect(profile.snapshot().scopes[0]?.cpu).toBeNull();
  profile.start(true);
  await pending;
  expect(profile.snapshot().scopes).toEqual([]);
  profile.run('control/current', () => busy(10));
  expect(profile.snapshot().scopes[0]?.cpu?.userUs).toBeGreaterThan(1000);
  profile.start(false);
  profile.run('schedule/default', () => busy(1));
  const result = profile.snapshot();
  expect(result.enabled).toBe(false);
  expect(result.scopes[0]?.runs).toBe(1);
  expect(result.scopes[0]?.cpu).toBeNull();
  expect(result.unattributed).toEqual(result.cpu);
  profile.close();
});
