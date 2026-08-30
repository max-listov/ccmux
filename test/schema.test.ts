import { expect, test } from 'bun:test';
import { MachineConfigSchema, SessionSchema } from '../src/config/schema.ts';

const UUID = '11111111-1111-4111-8111-111111111111';

test('SessionSchema applies defaults', () => {
  const s = SessionSchema.parse({ name: 'cc-x', dir: '/home/user', uuid: UUID, agent: 'claude' });
  expect(s.flags).toEqual([]);
  expect(s.archived).toBe(false);
  expect(s.resumeText).toBe('continue');
});

test('SessionSchema preserves weird flags verbatim (the [1m] glob bug class is gone)', () => {
  const s = SessionSchema.parse({
    name: 'cc-x',
    dir: '/home/user',
    uuid: UUID,
    agent: 'claude',
    flags: ['--model', 'claude-opus-4-8[1m]'],
  });
  expect(s.flags).toEqual(['--model', 'claude-opus-4-8[1m]']);
});

test('SessionSchema rejects bad names / relative dir / bad uuid', () => {
  expect(() =>
    SessionSchema.parse({ name: 'a|b', dir: '/x', uuid: UUID, agent: 'claude' }),
  ).toThrow();
  expect(() =>
    SessionSchema.parse({ name: 'a b', dir: '/x', uuid: UUID, agent: 'claude' }),
  ).toThrow();
  expect(() =>
    SessionSchema.parse({ name: 'cc-x', dir: 'rel/path', uuid: UUID, agent: 'claude' }),
  ).toThrow();
  expect(() =>
    SessionSchema.parse({ name: 'cc-x', dir: '/x', uuid: 'not-a-uuid', agent: 'claude' }),
  ).toThrow();
  expect(() => SessionSchema.parse({ name: 'cc-x', dir: '/x', uuid: UUID })).toThrow();
});

test('MachineConfig: permissionMode is locked to auto — config cannot escalate', () => {
  const base = {
    claudeBin: '/bin/claude',
    tmuxBin: '/bin/tmux',
    projectsDir: '/root/.claude/projects',
    rcPrefix: 'prod',
    stateDir: '/home/user',
    bootLabel: 'ccmux.service',
  };
  const m = MachineConfigSchema.parse(base);
  expect(m.permissionMode).toBe('auto');
  expect(m.ensureInterval).toBe(30);
  expect(m.codexCorrelationTimeoutMs).toBe(30_000);
  expect(() => MachineConfigSchema.parse({ ...base, permissionMode: 'yolo' })).toThrow();
});

test('MachineConfig: rcPrefix is a required lowercase slug (any machine label, not a fixed enum)', () => {
  const base = {
    claudeBin: '/bin/claude',
    tmuxBin: '/bin/tmux',
    projectsDir: '/root/.claude/projects',
    stateDir: '/home/user',
    bootLabel: 'ccmux.service',
  };
  // any lowercase slug is valid — the fleet isn't capped at local/dev/prod
  for (const p of ['local', 'dev', 'prod', 'staging', 'edge-1']) {
    expect(MachineConfigSchema.parse({ ...base, rcPrefix: p }).rcPrefix).toBe(p);
  }
  // but garbage still loud-fails (the real intent of the old enum)
  for (const bad of ['', 'Dev', 'a b', '-x', '1box']) {
    expect(() => MachineConfigSchema.parse({ ...base, rcPrefix: bad })).toThrow();
  }
  // required: missing throws
  expect(() => MachineConfigSchema.parse(base)).toThrow();
});
