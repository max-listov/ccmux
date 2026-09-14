import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

// A child process, because the home directory is fixed when the module loads.
test('loadMachineConfig: a runtime installed in its usual place resolves without it on PATH', () => {
  const home = mkdtempSync(join(tmpdir(), 'ccmux-home-'));
  const bin = join(home, '.bun', 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['opencode', 'codex']) {
    writeFileSync(join(bin, name), '#!/bin/sh\n');
    chmodSync(join(bin, name), 0o755);
  }
  const cfg = join(home, 'machine.json');
  writeFileSync(
    cfg,
    JSON.stringify({ rcPrefix: 'dev', claudeBin: '/x/claude', tmuxBin: '/x/tmux' }),
  );
  const machine = new URL('../src/config/machine.ts', import.meta.url).pathname;
  const probe = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `const { loadMachineConfig } = await import(${JSON.stringify(machine)}); const m = loadMachineConfig(); console.log(JSON.stringify([m.opencodeBin ?? null, m.codexBin ?? null]));`,
    ],
    { env: { HOME: home, PATH: '/usr/bin:/bin', CCMUX_CONFIG: cfg }, stderr: 'pipe' },
  );
  expect(probe.stderr.toString()).toBe('');
  expect(JSON.parse(probe.stdout.toString())).toEqual([join(bin, 'opencode'), join(bin, 'codex')]);
});
