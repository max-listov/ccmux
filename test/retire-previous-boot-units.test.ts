import { expect, test } from 'bun:test';
import { retirePreviousBootUnits } from '../src/boot/install.ts';
import { makeMachine } from './helpers.ts';

function host(mac: boolean, present: string[]) {
  const calls: string[][] = [];
  const removed: string[] = [];
  const copied: string[][] = [];
  const files = new Set(present);
  return {
    calls,
    removed,
    copied,
    deps: {
      copyDir: (from: string, to: string) => {
        copied.push([from, to]);
        files.add(to);
      },
      mac,
      run: async (argv: string[]) => {
        calls.push(argv);
      },
      exists: (path: string) => files.has(path),
      unlink: (path: string) => {
        removed.push(path);
        files.delete(path);
      },
      plistPath: (label: string) => `/plists/${label}.plist`,
      unitPath: (unit: string) => `/units/${unit}`,
    },
  };
}

test('on macOS the previous daemon is booted out and removed, the previous tmux agent only loses its plist', async () => {
  const h = host(true, ['/plists/com.ccmux.daemon.plist', '/plists/com.ccmux.tmux.plist']);
  const m = makeMachine({ bootLabel: 'com.stitchmux.daemon' });
  await retirePreviousBootUnits(m, h.deps);
  expect(h.calls.map((argv) => argv.slice(0, 2))).toEqual([['launchctl', 'bootout']]);
  expect(h.calls[0]?.[2]).toEndWith('/com.ccmux.daemon');
  expect(h.removed).toEqual(['/plists/com.ccmux.daemon.plist', '/plists/com.ccmux.tmux.plist']);
});

test('on Linux the previous service is disabled, stopped and removed', async () => {
  const h = host(false, ['/units/ccmux.service']);
  await retirePreviousBootUnits(makeMachine({ bootLabel: 'stitchmux.service' }), h.deps);
  expect(h.calls).toEqual([
    ['systemctl', 'disable', '--now', 'ccmux.service'],
    ['systemctl', 'daemon-reload'],
  ]);
  expect(h.removed).toEqual(['/units/ccmux.service']);
});

test('nothing is retired when no previous unit exists or the machine still uses its label', async () => {
  const none = host(false, []);
  expect(
    await retirePreviousBootUnits(makeMachine({ bootLabel: 'stitchmux.service' }), none.deps),
  ).toEqual([]);
  const same = host(false, ['/units/ccmux.service']);
  expect(
    await retirePreviousBootUnits(makeMachine({ bootLabel: 'ccmux.service' }), same.deps),
  ).toEqual([]);
  expect(same.calls).toEqual([]);
});

test('on Linux the machine’s drop-ins for the previous service carry over to the new one', async () => {
  const h = host(false, ['/units/ccmux.service', '/units/ccmux.service.d']);
  await retirePreviousBootUnits(makeMachine({ bootLabel: 'stitchmux.service' }), h.deps);
  expect(h.copied).toEqual([['/units/ccmux.service.d', '/units/stitchmux.service.d']]);
  // Drop-ins the new service already has are the machine's newer word and stay.
  const again = host(false, [
    '/units/ccmux.service',
    '/units/ccmux.service.d',
    '/units/stitchmux.service.d',
  ]);
  await retirePreviousBootUnits(makeMachine({ bootLabel: 'stitchmux.service' }), again.deps);
  expect(again.copied).toEqual([]);
});
