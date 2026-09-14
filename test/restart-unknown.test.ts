import { expect, test } from 'bun:test';
import { formatFleetSession, RemoteSessionSchema } from '../src/commands/fleetList.ts';

const row = (extra: Record<string, unknown> = {}) =>
  RemoteSessionSchema.parse({
    name: 'agent-a',
    agent: 'opencode',
    state: 'idle',
    running: true,
    dir: '/src/agent-a',
    uptime: { text: '1m' },
    ...extra,
  });

test('a row whose restart effect could not be measured says so, not "nothing to pick up"', () => {
  const line = formatFleetSession(
    'host-a',
    row({ staleUnknown: 'launch recipe cannot be built: Native executable is unavailable' }),
  );
  expect(line).toContain('⟳ ?');
});

test('a measured row with nothing to pick up shows no restart marker', () => {
  expect(formatFleetSession('host-a', row())).not.toContain('⟳');
});

test('restart reasons win over the unmeasured marker when both are present', () => {
  const line = formatFleetSession('host-a', row({ stale: ['rules'], staleUnknown: 'x' }));
  expect(line).toContain('⟳ rules');
  expect(line).not.toContain('⟳ ?');
});

test('a row from a peer that predates the field reads as measured', () => {
  expect(row().staleUnknown).toBeNull();
});
