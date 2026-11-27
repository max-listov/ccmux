import { afterEach, expect, test } from 'bun:test';
import {
  cgroupUnitOf,
  launchInBoundary,
  observeSessionBoundary,
  resetSystemdScopeProbe,
  SessionBoundarySchema,
  systemdScopeArgs,
} from '../src/session/boundary.ts';

afterEach(() => resetSystemdScopeProbe());

const linux = (opts: { uid?: number; works?: boolean; systemd?: boolean } = {}) =>
  systemdScopeArgs(
    'linux',
    opts.uid ?? 0,
    (bin) => `/usr/bin/${bin}`,
    (path) => path === '/run/systemd/system' && opts.systemd !== false,
    () => opts.works !== false,
  );

test('systemd gives a scope only where it can create one', () => {
  expect(linux()).toEqual(['/usr/bin/systemd-run']);
  resetSystemdScopeProbe();
  expect(linux({ uid: 1000 })).toEqual(['/usr/bin/systemd-run', '--user']);
  resetSystemdScopeProbe();
  expect(linux({ works: false })).toBeNull();
  resetSystemdScopeProbe();
  expect(linux({ systemd: false })).toBeNull();
  resetSystemdScopeProbe();
  expect(systemdScopeArgs('darwin', 501)).toBeNull();
});

test('a session is launched in its own uniquely named scope, or unchanged without one', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  expect(
    launchInBoundary({ uuid }, ['stitchmux', '_run', 'agent-a'], ['/usr/bin/systemd-run'], 0),
  ).toEqual([
    '/usr/bin/systemd-run',
    '--scope',
    '--quiet',
    '--collect',
    `--unit=stitchmux-session-${uuid}-0`,
    '--',
    'stitchmux',
    '_run',
    'agent-a',
  ]);
  expect(launchInBoundary({ uuid }, ['stitchmux', '_run', 'agent-a'], null)).toEqual([
    'stitchmux',
    '_run',
    'agent-a',
  ]);
});

test('the unit is read from a cgroup v2 or v1 line, and is null for none', () => {
  const v2 = '0::/system.slice/stitchmux-session-u-1.scope\n';
  expect(cgroupUnitOf(1, () => v2)).toBe('stitchmux-session-u-1.scope');
  const v1 = '12:cpu,cpuacct:/\n1:name=systemd:/system.slice/stitchmux.service\n';
  expect(cgroupUnitOf(1, () => v1)).toBe('stitchmux.service');
  expect(cgroupUnitOf(1, () => '0::/\n')).toBeNull();
  expect(
    cgroupUnitOf(1, () => {
      throw new Error('ENOENT');
    }),
  ).toBeNull();
});

test('a boundary names each root with its process instance, and is null with no roots', async () => {
  expect(await observeSessionBoundary([])).toBeNull();
  const boundary = await observeSessionBoundary([process.pid]);
  expect(SessionBoundarySchema.parse(boundary)).toMatchObject({
    unit: process.platform === 'linux' ? expect.any(String) : null,
    roots: [{ pid: process.pid }],
  });
  expect(boundary?.roots[0]?.instance).not.toBeNull();
});

test('a running session’s monitoring row carries its boundary, a stopped one carries none', async () => {
  const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { projectMonitoringRow } = await import('../src/monitoring/project.ts');
  const { MonitoringRowSchema } = await import('../src/monitoring/schema.ts');
  const { UNSEEN } = await import('../src/events/observe.ts');
  const { makeMachine, makeSession } = await import('./helpers.ts');
  const root = realpathSync(mkdtempSync('/tmp/stitchmux-boundary-row-'));
  try {
    const m = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
    const s = makeSession({ name: 'agent-a', agent: 'claude', dir: root });
    const boundary = await observeSessionBoundary([process.pid]);
    const now = Date.now();
    const running = projectMonitoringRow(
      m,
      s,
      Math.floor(now / 1000),
      null,
      UNSEEN,
      now,
      1,
      boundary,
    );
    expect(MonitoringRowSchema.parse(running).boundary).toEqual(boundary);
    const stopped = projectMonitoringRow(m, s, undefined, null, UNSEEN, now, 0, boundary);
    expect(stopped.boundary).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
