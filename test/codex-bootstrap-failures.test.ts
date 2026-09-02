import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import { exhaustedBudgetReason } from '../src/commands/bootstrap.ts';
import { lifecycleBlockPath } from '../src/config/paths.ts';
import { loadPendingSessions, reservePendingSession } from '../src/config/pendingSessions.ts';
import { MachineConfigSchema, PendingSessionSchema } from '../src/config/schema.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { hasSession, tmuxArgv } from '../src/tmux/tmux.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
type FailureMode = 'crash' | 'timeout' | 'ambiguous';

function fakeCodex(
  mode: FailureMode,
  path: string,
  codexSessionsDir: string,
  invocationPath: string,
): void {
  const common = ['#!/bin/sh', `printf "1\\n" >> "${invocationPath}"`];
  const behavior =
    mode === 'crash'
      ? ['exit 17']
      : mode === 'timeout'
        ? ['sleep 30']
        : [
            `mkdir -p "${codexSessionsDir}/probe"`,
            `printf '{"type":"session_meta","payload":{"id":"11111111-1111-4111-8111-111111111111","originator":"%s"}}\\n' "$CODEX_INTERNAL_ORIGINATOR_OVERRIDE" > "${codexSessionsDir}/probe/rollout-a-11111111-1111-4111-8111-111111111111.jsonl"`,
            `printf '{"type":"session_meta","payload":{"id":"22222222-2222-4222-8222-222222222222","originator":"%s"}}\\n' "$CODEX_INTERNAL_ORIGINATOR_OVERRIDE" > "${codexSessionsDir}/probe/rollout-b-22222222-2222-4222-8222-222222222222.jsonl"`,
            'sleep 30',
          ];
  writeFileSync(path, `${[...common, ...behavior].join('\n')}\n`);
  chmodSync(path, 0o700);
}

async function runFailure(mode: FailureMode): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `ccmux-codex-${mode}-`));
  const work = join(root, 'work');
  const stateDir = join(root, 'state');
  const codexHome = join(root, 'codex-home');
  const codexSessionsDir = join(codexHome, 'sessions');
  const fake = join(root, 'codex');
  const invocationPath = join(root, 'invocations');
  const configPath = join(root, 'machine.json');
  const tmuxBin = Bun.which('tmux');
  if (!tmuxBin) throw new Error('tmux is required for bootstrap failure integration tests');
  for (const dir of [work, stateDir, codexSessionsDir]) mkdirSync(dir, { recursive: true });
  fakeCodex(mode, fake, codexSessionsDir, invocationPath);
  const machine = MachineConfigSchema.parse({
    claudeBin: '/bin/sh',
    codexBin: fake,
    tmuxBin,
    tmuxSocket: `ccmux-codex-${mode}-${process.pid}`,
    projectsDir: join(root, 'claude-projects'),
    codexHome,
    codexSessionsDir,
    stateDir,
    rcPrefix: 'host-a',
    bootLabel: 'ccmux-probe.service',
    remoteControl: false,
    autoUpdate: false,
    codexCorrelationTimeoutMs: 1_500,
  });
  writeFileSync(configPath, `${JSON.stringify(machine)}\n`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = configPath;
  env.CCMUX_STATE_DIR = stateDir;
  env.CCMUX_CACHE_DIR = join(root, 'cache');
  env.CODEX_HOME = codexHome;

  try {
    const proc = Bun.spawn(['bun', CLI, 'new', 'agent-a', work, '--agent', 'codex'], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    const logPath = join(stateDir, 'ccmux.log');
    const stateLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const output = `${await stdout}\n${await stderr}\n${stateLog}`;
    expect(output).toContain(
      mode === 'crash'
        ? 'exited before writing session_meta'
        : mode === 'timeout'
          ? 'correlation timed out'
          : 'refusing ambiguous promotion',
    );
    // A crash must never be announced as a timeout, whatever the budget did — see the test that
    // exhausts the budget first.
    if (mode === 'crash') expect(output).not.toContain('correlation timed out');
    expect(loadSessions(machine)).toEqual([]);
    expect(loadPendingSessions(machine)).toEqual([]);
    expect(await hasSession(machine, 'agent-a')).toBe(false);
    expect(existsSync(lifecycleBlockPath(machine, 'agent-a'))).toBe(false);
    // "Did not retry", not "ran exactly once". The file is written by the fake's first line, so a
    // machine slow enough that the child has not reached it inside the correlation budget leaves no
    // file at all — and that is still a pass for what this asserts: nothing was launched twice. It
    // failed as ENOENT here on a loaded host. That the child DID run, where it matters, is carried
    // by the mode-specific assertions above: a crash cannot be reported without one, and the
    // ambiguous case is proved by the rollouts it wrote.
    const invocations = existsSync(invocationPath)
      ? readFileSync(invocationPath, 'utf8').trim().split('\n').filter(Boolean).length
      : 0;
    expect(invocations).toBeLessThanOrEqual(1);
    const rollouts = [...new Glob('**/rollout-*.jsonl').scanSync({ cwd: codexSessionsDir })];
    expect(rollouts).toHaveLength(mode === 'ambiguous' ? 2 : 0);
  } finally {
    Bun.spawnSync(tmuxArgv(machine, 'kill-server'), { stdout: 'ignore', stderr: 'ignore' });
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * These are INTEGRATION tests: each spawns a real CLI process against a real tmux server and waits
 * out a real correlation deadline. Their honest cost is ~400ms, but the default per-test budget is
 * five seconds and that is not headroom on a loaded machine — measured, one of them took 5000.76ms
 * on a CI runner executing two jobs of the same commit at once, and the SAME test passed in 444ms in
 * the other job. A gate that fails on how busy the runner is teaches people to re-run gates, which
 * is the habit that eventually waves a real failure through.
 *
 * So the budget is stated, and stated generously: thirty seconds is still nowhere near a hang, and a
 * genuine regression here fails on its assertion rather than on the clock.
 */
const INTEGRATION_TIMEOUT_MS = 30_000;

test(
  'fresh Codex child crash rolls back once without lifecycle residue',
  () => runFailure('crash'),
  INTEGRATION_TIMEOUT_MS,
);
test(
  'fresh Codex correlation timeout kills the only child and rolls back',
  () => runFailure('timeout'),
  INTEGRATION_TIMEOUT_MS,
);
test(
  'ambiguous persisted markers preserve rollouts but never promote either UUID',
  () => runFailure('ambiguous'),
  INTEGRATION_TIMEOUT_MS,
);

test(
  'bootstrap performs exact-generation cleanup even when no initiating CLI is alive',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccmux-codex-orphan-bootstrap-'));
    const work = join(root, 'work');
    const stateDir = join(root, 'state');
    const codexHome = join(root, 'codex-home');
    const codexSessionsDir = join(codexHome, 'sessions');
    const fake = join(root, 'codex');
    const invocationPath = join(root, 'invocations');
    const configPath = join(root, 'machine.json');
    const generation = '33333333-3333-4333-8333-333333333333';
    const tmuxBin = Bun.which('tmux');
    if (!tmuxBin) throw new Error('tmux is required for bootstrap failure integration tests');
    for (const dir of [work, stateDir, codexSessionsDir]) mkdirSync(dir, { recursive: true });
    fakeCodex('crash', fake, codexSessionsDir, invocationPath);
    const machine = MachineConfigSchema.parse({
      claudeBin: '/bin/sh',
      codexBin: fake,
      tmuxBin,
      tmuxSocket: `ccmux-codex-orphan-${process.pid}`,
      projectsDir: join(root, 'claude-projects'),
      codexHome,
      codexSessionsDir,
      stateDir,
      rcPrefix: 'host-a',
      bootLabel: 'ccmux-probe.service',
      remoteControl: false,
      autoUpdate: false,
      codexCorrelationTimeoutMs: 1_500,
    });
    writeFileSync(configPath, `${JSON.stringify(machine)}\n`);
    await reservePendingSession(
      machine,
      PendingSessionSchema.parse({
        generation,
        marker: `ccmux_${generation}`,
        operation: { kind: 'create' },
        session: { name: 'agent-a', dir: work, agent: 'codex', flags: [] },
        createdAt: '2026-08-10T00:00:00.000Z',
        status: 'pending',
      }),
    );
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) env[key] = value;
    env.CCMUX_CONFIG = configPath;
    env.CCMUX_STATE_DIR = stateDir;
    env.CCMUX_CACHE_DIR = join(root, 'cache');
    env.CODEX_HOME = codexHome;

    try {
      const proc = Bun.spawn(['bun', CLI, '_bootstrap', generation], {
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await proc.exited).toBe(1);
      expect(loadPendingSessions(machine)).toEqual([]);
      expect(loadSessions(machine)).toEqual([]);
      expect(readFileSync(invocationPath, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(existsSync(lifecycleBlockPath(machine, 'agent-a'))).toBe(true);
    } finally {
      Bun.spawnSync(tmuxArgv(machine, 'kill-server'), { stdout: 'ignore', stderr: 'ignore' });
      rmSync(root, { recursive: true, force: true });
    }
  },
  INTEGRATION_TIMEOUT_MS,
);

/**
 * Which fact the correlation loop reports once its budget is spent. This is a decision, not a race,
 * so it is tested as one: staging the race itself would need the child to die inside a specific
 * fifty-millisecond window, and a test that can only pass by being lucky asserts nothing. The
 * ordering it stands in for is real and was measured on a loaded machine — the deadline was noticed
 * first and a crashed child was announced as a timeout.
 */
test('a spent budget reports the exit status, not whichever fact the loop saw first', () => {
  expect(exhaustedBudgetReason('create', null)).toContain('correlation timed out');
  expect(exhaustedBudgetReason('fork', null)).toContain('correlation timed out');
  expect(exhaustedBudgetReason('adopt', null)).toContain('correlation timed out');

  // A child that is already gone is named as gone, whatever the clock did.
  expect(exhaustedBudgetReason('create', 17)).toContain('exited before writing session_meta');
  expect(exhaustedBudgetReason('fork', 1)).toContain('exited before writing session_meta');
  expect(exhaustedBudgetReason('create', 0)).toContain('exited before writing session_meta');
  for (const kind of ['create', 'fork', 'adopt'] as const)
    expect(exhaustedBudgetReason(kind, 17)).not.toContain('correlation timed out');

  // Adoption never wrote a session_meta to miss: its child was asking an existing writer for
  // admission, so the block says that instead.
  expect(exhaustedBudgetReason('adopt', 17)).toContain('rejected by the active writer');
});
