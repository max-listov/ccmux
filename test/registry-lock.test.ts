import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionRegistryLockPath } from '../src/config/paths.ts';
import { withSessionRegistryLock } from '../src/session/registryLock.ts';
import { makeMachine } from './helpers.ts';

// The lock is stitchkit's `withExclusiveLock`; these hold what ccmux relies on through it.

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
