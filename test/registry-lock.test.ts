import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionRegistryLockPath } from '../src/config/paths.ts';
import { withSessionRegistryLock } from '../src/session/registryLock.ts';
import { makeMachine } from './helpers.ts';

// The lock is stitchkit's `withExclusiveLock`; these hold what ccmux relies on through it, and the
// migration from the directory form older ccmux processes still take at the same path.

const DEAD_PID = 2_147_483_647;
const TOKEN = '11111111-1111-4111-8111-111111111111';

function legacyHeld(lock: string, pid: number): void {
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), `${JSON.stringify({ pid, token: TOKEN })}\n`);
}

async function withTempState<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = mkdtempSync(join(tmpdir(), 'ccmux-registry-lock-'));
  try {
    return await run(stateDir);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test('transactions under the lock never overlap', async () => {
  await withTempState(async (stateDir) => {
    const machine = makeMachine({ stateDir });
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withSessionRegistryLock(machine, async () => {
          most = Math.max(most, ++inside);
          await Bun.sleep(5);
          inside--;
        }),
      ),
    );
    expect(most).toBe(1);
  });
});

test('a directory lock left by a dead older process is cleared at once, at any age', async () => {
  await withTempState(async (stateDir) => {
    const machine = makeMachine({ stateDir });
    legacyHeld(sessionRegistryLockPath(machine), DEAD_PID);
    const started = Date.now();
    await expect(withSessionRegistryLock(machine, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(withSessionRegistryLock(machine, async () => 'reused')).resolves.toBe('reused');
  });
});

test('a directory lock that never recorded an owner is cleared only past the grace', async () => {
  await withTempState(async (stateDir) => {
    const machine = makeMachine({ stateDir });
    const lock = sessionRegistryLockPath(machine);
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await expect(withSessionRegistryLock(machine, async () => 'took it')).resolves.toBe('took it');
  });
});

test('a directory lock held by a LIVE older process is waited for, never taken', async () => {
  await withTempState(async (stateDir) => {
    const machine = makeMachine({ stateDir });
    const lock = sessionRegistryLockPath(machine);
    legacyHeld(lock, process.pid);
    let ran = false;
    const waiting = withSessionRegistryLock(machine, async () => {
      ran = true;
    });
    await Bun.sleep(300);
    expect(ran).toBe(false);
    rmSync(lock, { recursive: true, force: true }); // the older holder releases
    await waiting;
    expect(ran).toBe(true);
  });
});

test('a cancelled waiter rejects with its own reason while the holder keeps the lock', async () => {
  await withTempState(async (stateDir) => {
    const machine = makeMachine({ stateDir });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withSessionRegistryLock(machine, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const cancellation = new AbortController();
    const started = Date.now();
    const waiting = withSessionRegistryLock(machine, async () => 'never', cancellation.signal);
    cancellation.abort(new Error('caller went away'));
    await expect(waiting).rejects.toThrow('caller went away');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(sessionRegistryLockPath(machine))).toBe(true);
    release.resolve();
    await holder;
  });
});

test('the lock is released when the transaction throws, not only when it returns', async () => {
  await withTempState(async (stateDir) => {
    const machine = makeMachine({ stateDir });
    await expect(
      withSessionRegistryLock(machine, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(sessionRegistryLockPath(machine))).toBe(false);
    await expect(withSessionRegistryLock(machine, async () => 'next')).resolves.toBe('next');
  });
});
