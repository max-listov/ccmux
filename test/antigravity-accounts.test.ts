import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  antigravityCanProbeUsage,
  antigravityFileAccount,
} from '../src/agent/antigravity/account.ts';
import { antigravityTierName } from '../src/agent/antigravity/catalog.ts';
import { antigravityDirFlags } from '../src/agent/antigravity/preflight.ts';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';
import { fleetAccounts, fleetMachineProfiles } from '../src/fleet/accounts.ts';
import { peerListMachine } from '../src/fleet/fleetList.ts';
import { packListAnswer } from '../src/fleet/peerRead.ts';
import {
  parseAntigravityLogIdentity,
  parseAntigravityUsage,
} from '../src/quota/antigravityUsage.ts';
import { probeAntigravity } from '../src/quota/probe.ts';
import { planWindowLabel } from '../src/runtime/planLimits.ts';
import { makeMachine } from './helpers.ts';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

test('parseAntigravityUsage inverts remaining_fraction, normalizes epoch-0 reset, skips disabled buckets, and refuses model turns', () => {
  const sample = JSON.stringify({
    status: 'SUCCESS',
    num_turns: 0,
    conversation_id: '',
    usage: { total_tokens: 0 },
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-weekly',
                name: 'Weekly',
                window: 'weekly',
                remaining_fraction: 0.04,
                reset_time: '2026-12-01T10:00:00Z',
              },
              {
                id: 'gemini-5h',
                name: '5-Hour',
                window: '5h',
                remaining_fraction: 1,
                reset_time: '1970-01-01T00:00:00Z',
              },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              {
                id: '3p-weekly',
                name: 'Weekly',
                window: 'weekly',
                remaining_fraction: 0,
                reset_time: '2026-12-01T10:00:00Z',
              },
              {
                id: '3p-5h',
                name: '5-Hour',
                window: '5h',
                remaining_fraction: 1,
                reset_time: null,
                disabled: true,
              },
            ],
          },
        ],
      },
    },
  });

  const parsed = parseAntigravityUsage(sample, NOW);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.limits.answer).toBe('known');
  expect(parsed.limits.source).toBe('probe');
  // Disabled 3p-5h is omitted; 3 active windows remain.
  expect(parsed.limits.windows).toEqual([
    {
      key: 'gemini-weekly',
      label: 'Weekly',
      percent: 96,
      windowMinutes: 10080,
      resetsAt: '2026-12-01T10:00:00.000Z',
      scope: 'Gemini Models',
    },
    {
      key: 'gemini-5h',
      label: '5-Hour',
      percent: 0,
      windowMinutes: 300,
      resetsAt: null,
      scope: 'Gemini Models',
    },
    {
      key: '3p-weekly',
      label: 'Weekly',
      percent: 100,
      windowMinutes: 10080,
      resetsAt: '2026-12-01T10:00:00.000Z',
      scope: 'Claude and GPT models',
    },
  ]);
  const [firstWindow, secondWindow] = parsed.limits.windows;
  expect(firstWindow).toBeDefined();
  expect(secondWindow).toBeDefined();
  if (firstWindow) expect(planWindowLabel(firstWindow)).toBe('7d Gemini Models');
  if (secondWindow) expect(planWindowLabel(secondWindow)).toBe('5h Gemini Models');

  // Negative controls: model turn, wrong command, failed status must all be refused.
  const modelTurn = JSON.parse(sample);
  modelTurn.num_turns = 1;
  expect(parseAntigravityUsage(JSON.stringify(modelTurn), NOW)).toMatchObject({ ok: false });

  const otherCmd = JSON.parse(sample);
  otherCmd.command.name = 'status';
  expect(parseAntigravityUsage(JSON.stringify(otherCmd), NOW)).toMatchObject({ ok: false });

  const failedStatus = JSON.parse(sample);
  failedStatus.status = 'ERROR';
  expect(parseAntigravityUsage(JSON.stringify(failedStatus), NOW)).toMatchObject({ ok: false });
});

test('parseAntigravityLogIdentity reads authenticated email without touching credentials', () => {
  const log = [
    'I1128 07:08:00.554013 1 auth.go:157] ChainedAuth: authenticated via keyring (effective: keyring)',
    'I1128 07:08:00.554035 1 server_oauth.go:221] applyAuthResult: email=agent-a@example.test, authMethod=consumer, quotaProject=',
    'I1128 07:08:00.554046 1 server_oauth.go:226] OAuth: authenticated successfully as agent-a@example.test',
  ].join('\n');
  expect(parseAntigravityLogIdentity(log)).toEqual({
    email: 'agent-a@example.test',
    authMethod: 'consumer',
  });
  expect(parseAntigravityLogIdentity('no auth lines here')).toEqual({
    email: null,
    authMethod: null,
  });
  expect(
    antigravityTierName({ antigravity: { tier: { name: 'Google AI Ultra', id: 'g1-ultra' } } }),
  ).toBe('Google AI Ultra');
  expect(antigravityTierName(undefined)).toBeNull();
});

test('antigravityCanProbeUsage refuses unauthenticated profiles before spawning agy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchmux-agy-gate-'));
  const emptyDir = join(root, 'empty');
  const signedDir = join(root, 'signed');
  const spawnMarker = join(root, 'spawned');
  mkdirSync(emptyDir, { recursive: true });
  mkdirSync(signedDir, { recursive: true });
  writeFileSync(
    join(signedDir, 'antigravity-oauth-token'),
    JSON.stringify({
      token: { access_token: 'never-read-by-stitchmux' },
      auth_method: 'consumer',
      id_token_email: 'agent-file@example.test',
    }),
  );
  const bin = join(root, 'agy');
  writeFileSync(bin, `#!/bin/sh\necho ran > "${spawnMarker}"\nexit 0\n`, { mode: 0o700 });

  try {
    // Named/file-backed profile without token file is refused fail-closed.
    expect(await antigravityCanProbeUsage(emptyDir, { forceFileStorage: true })).toMatchObject({
      ok: false,
    });
    // macOS default profile with negative metadata Keychain probe is refused fail-closed.
    writeFileSync(join(emptyDir, 'installation_id'), 'id\n');
    expect(
      await antigravityCanProbeUsage(emptyDir, {
        forceFileStorage: false,
        platform: 'darwin',
        keychainProbe: async () => false,
      }),
    ).toMatchObject({ ok: false });
    // Linux default profile without token file is refused fail-closed.
    expect(
      await antigravityCanProbeUsage(emptyDir, { forceFileStorage: false, platform: 'linux' }),
    ).toMatchObject({ ok: false });
    // Signed file-backed profile passes the gate and reads only email metadata.
    expect(await antigravityCanProbeUsage(signedDir, { forceFileStorage: true })).toEqual({
      ok: true,
    });
    expect(antigravityFileAccount(signedDir)).toEqual({
      label: 'agent-file@example.test',
      organization: null,
      subscription: null,
      provider: 'antigravity',
    });

    // End-to-end negative control: probeAntigravity does NOT spawn the binary when unsigned.
    const m = makeMachine({ antigravityBin: bin, antigravityDataDir: emptyDir });
    const refused = await probeAntigravity(m, {
      provider: 'antigravity',
      key: `antigravity:${emptyDir}`,
      home: emptyDir,
      envFile: null,
    });
    expect(refused.ok).toBe(false);
    expect(() => readFileSync(spawnMarker)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('antigravityDirFlags uses relative --app_data_dir under ~/.gemini and adds --gemini_dir outside', () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchmux-agy-flags-'));
  try {
    expect(antigravityDirFlags(join(root, '.gemini', 'antigravity-cli'), root)).toEqual([]);
    expect(antigravityDirFlags(join(root, '.gemini', 'antigravity-cli-2'), root)).toEqual([
      '--app_data_dir',
      'antigravity-cli-2',
    ]);
    expect(antigravityDirFlags(join(root, 'custom', 'profile-a'), root)).toEqual([
      '--gemini_dir',
      join(root, 'custom'),
      '--app_data_dir',
      'profile-a',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fleetAccounts keeps unlabelled measured profiles separate per machine and merges remote 0-session profiles', () => {
  const limits = {
    answer: 'known' as const,
    plan: 'Google AI Ultra',
    source: 'probe' as const,
    observedAt: new Date(NOW).toISOString(),
    error: null,
    windows: [
      {
        key: 'gemini-weekly',
        label: 'Weekly',
        percent: 96,
        windowMinutes: 10080,
        resetsAt: '2026-12-01T10:00:00.000Z',
        scope: 'Gemini Models',
      },
    ],
  };

  // Unlabelled profiles on two machines must never merge into one row.
  const unlabelled = fleetAccounts([], NOW, [
    {
      machine: 'host-a',
      view: {
        key: 'antigravity:default',
        provider: 'antigravity',
        account: null,
        limits,
        error: null,
        attemptedAt: new Date(NOW).toISOString(),
        home: null,
        sessions: [],
        identityChanged: false,
      },
    },
    {
      machine: 'host-b',
      view: {
        key: 'antigravity:default',
        provider: 'antigravity',
        account: null,
        limits,
        error: null,
        attemptedAt: new Date(NOW).toISOString(),
        home: null,
        sessions: [],
        identityChanged: false,
      },
    },
  ]);
  expect(unlabelled.map((a) => [a.id, a.label, a.provider])).toEqual([
    ['antigravity:host-a:default', 'host-a:default', 'antigravity'],
    ['antigravity:host-b:default', 'host-b:default', 'antigravity'],
  ]);

  // Remote peer's 0-session Antigravity profile arrives via packed `_peer-read list` payload.
  const packed = packListAnswer(
    {
      version: '0.96.2',
      generatedAt: new Date(NOW).toISOString(),
      rcPrefix: 'host-b',
      stateDir: '/tmp/state',
      release: {
        current: '0.96.2',
        latest: null,
        latestAt: null,
        checkedAt: null,
        ok: true,
        checksOverdue: false,
      },
      sessions: [],
      inventory: null,
      profiles: [
        {
          key: 'antigravity:default',
          provider: 'antigravity',
          account: {
            label: 'remote-ag@example.test',
            organization: null,
            subscription: null,
            provider: 'antigravity',
          },
          limits,
          error: null,
          attemptedAt: new Date(NOW).toISOString(),
          home: null,
          sessions: [],
        },
      ],
    },
    new Set(),
  );
  const remoteMachine = peerListMachine('host-b', 'ssh-b', {
    code: 0,
    stdout: JSON.stringify(packed),
    stderr: '',
    transportFailed: false,
    delivery: 'received',
  });
  expect(remoteMachine.ok).toBe(true);
  const allProfiles = fleetMachineProfiles([remoteMachine], []);
  const accounts = fleetAccounts([remoteMachine], NOW, allProfiles);
  expect(accounts).toHaveLength(1);
  expect(accounts[0]?.id).toBe('antigravity:remote-ag@example.test');
  expect(accounts[0]?.profiles).toEqual([
    {
      machine: 'host-b',
      profile: 'default',
      sessions: 0,
      error: null,
      attemptedAt: new Date(NOW).toISOString(),
    },
  ]);
});

test('stitchmux accounts --local --refresh discovers and probes Antigravity end-to-end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchmux-ag-cmd-'));
  const home = join(root, 'home');
  const agDir = join(home, '.gemini', 'antigravity-cli');
  mkdirSync(agDir, { recursive: true });
  writeFileSync(
    join(agDir, 'antigravity-oauth-token'),
    JSON.stringify({
      token: { access_token: 'stub' },
      auth_method: 'consumer',
      id_token_email: 'ag-user@example.test',
    }),
  );
  const agy = join(root, 'agy');
  writeFileSync(
    agy,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const logIdx = args.indexOf('--log-file');
if (logIdx >= 0 && args[logIdx + 1]) {
  await Bun.write(args[logIdx + 1], 'applyAuthResult: email=ag-user@example.test, authMethod=consumer\\n');
}
console.log(JSON.stringify({
  status: 'SUCCESS',
  num_turns: 0,
  conversation_id: '',
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remaining_fraction: 0.25, reset_time: '2026-12-01T00:00:00Z' },
          ],
        },
      ],
    },
  },
}));
`,
  );
  chmodSync(agy, 0o755);
  const tmux = join(root, 'tmux');
  writeFileSync(tmux, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const claude = join(root, 'claude');
  writeFileSync(claude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const state = join(root, 'state');
  const machine = MachineConfigSchema.parse({
    claudeBin: claude,
    antigravityBin: agy,
    antigravityDataDir: agDir,
    tmuxBin: tmux,
    projectsDir: join(root, 'claude-projects'),
    codexSessionsDir: join(root, 'codex-sessions'),
    rcPrefix: 'host-a',
    stateDir: state,
    bootLabel: 'stitchmux-test.service',
  });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(machine));

  try {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) env[key] = value;
    env.STITCHMUX_CONFIG = config;
    env.STITCHMUX_STATE_DIR = state;
    env.HOME = home;
    delete env.CLAUDE_CONFIG_DIR;

    const proc = Bun.spawn(['bun', CLI, 'accounts', '--local', '--refresh', '--json'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    const answer = JSON.parse(stdout) as {
      accounts: {
        id: string;
        provider: string | null;
        limits: { source: string; windows: { key: string; percent: number }[] } | null;
      }[];
      problems: unknown[];
    };
    const ag = answer.accounts.find((a) => a.id === 'antigravity:ag-user@example.test');
    expect(ag).toBeDefined();
    expect(ag?.provider).toBe('antigravity');
    expect(ag?.limits?.source).toBe('probe');
    expect(ag?.limits?.windows).toMatchObject([{ key: 'gemini-weekly', percent: 75 }]);
    expect(answer.problems).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
