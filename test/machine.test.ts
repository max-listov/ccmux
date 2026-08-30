import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMachineConfig, rcName } from '../src/config/machine.ts';
import { sessionsPath } from '../src/config/paths.ts';
import { makeMachine } from './helpers.ts';

test('rcName: <prefix>-<name without cc->, single strip only', () => {
  const m = makeMachine({ rcPrefix: 'prod' });
  expect(rcName(m, 'cc-api')).toBe('prod-api');
  expect(rcName(m, 'plain')).toBe('prod-plain');
  expect(rcName(m, 'cc-cc-x')).toBe('prod-cc-x');
});

test('loadMachineConfig: file over defaults, defaults applied, env override wins', () => {
  const cfg = join(mkdtempSync(join(tmpdir(), 'ccmux-mc-')), 'machine.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      rcPrefix: 'dev',
      claudeBin: '/x/claude',
      tmuxBin: '/x/tmux',
      projectsDir: '/root/.claude/projects',
      stateDir: '/x',
      bootLabel: 'ccmux.service',
    }),
  );
  const prevCfg = process.env.CCMUX_CONFIG;
  process.env.CCMUX_CONFIG = cfg;
  try {
    const m = loadMachineConfig();
    expect(m.rcPrefix).toBe('dev');
    expect(m.ensureInterval).toBe(30); // default applied
    expect(m.permissionMode).toBe('auto');
    // Every state file is NAMED inside the configured directory — the file no longer decides where
    // its neighbours live, which is what used to let one careless path relocate the whole set.
    expect(sessionsPath(m)).toBe('/x/sessions.jsonl');
  } finally {
    if (prevCfg === undefined) delete process.env.CCMUX_CONFIG;
    else process.env.CCMUX_CONFIG = prevCfg;
  }
});
