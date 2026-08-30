import { expect, test } from 'bun:test';
import { MachineConfigSchema } from '../src/config/schema.ts';
import { tmuxArgv } from '../src/tmux/tmux.ts';

const cfg = (extra: Record<string, unknown>) =>
  MachineConfigSchema.parse({
    claudeBin: '/bin/claude',
    tmuxBin: '/bin/tmux',
    projectsDir: '/p',
    rcPrefix: 'test',
    stateDir: '/tmp',
    bootLabel: 'b',
    ...extra,
  });

test('tmuxArgv without a socket → default socket (no -L), i.e. current prod behaviour', () => {
  expect(tmuxArgv(cfg({}), 'list-sessions', '-F', '#{session_name}')).toEqual([
    '/bin/tmux',
    'list-sessions',
    '-F',
    '#{session_name}',
  ]);
});

test('tmuxArgv with tmuxSocket → every call scoped to that socket via -L', () => {
  expect(tmuxArgv(cfg({ tmuxSocket: 'ccmux-dev' }), 'new-session', '-d', '-s', 'dev-a')).toEqual([
    '/bin/tmux',
    '-L',
    'ccmux-dev',
    'new-session',
    '-d',
    '-s',
    'dev-a',
  ]);
});
