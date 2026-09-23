import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * `ccmux state` answers a job that outlived its view of the session that started it. Three answers
 * must never be confused: the session exists (0), it does not (3), the question could not be asked
 * (1). And `--since` must tell the life that was running then from a later one at the same address.
 */
const root = mkdtempSync(join(tmpdir(), 'ccmux-state-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// tmux as the list reads it: one live session created at a known second; nothing else is running.
const LIFE_STARTED = Date.parse('2026-09-23T01:00:00.000Z') / 1000;
const tmuxBin = join(root, 'tmux');
writeFileSync(
  tmuxBin,
  `#!/bin/sh\ncase "$*" in\n  *list-sessions*) echo "agent-a ${LIFE_STARTED}" ;;\nesac\nexit 0\n`,
);
chmodSync(tmuxBin, 0o755);
const machine = makeMachine({ stateDir: root, rcPrefix: 'host-a', tmuxBin, projectsDir: root });
const configPath = join(root, 'machine.json');
writeFileSync(configPath, `${JSON.stringify(machine)}\n`);
const running = makeSession({ name: 'agent-a', dir: root });
const stopped = makeSession({
  name: 'agent-b',
  dir: root,
  uuid: '22222222-2222-4222-8222-222222222222',
});
writeFileSync(
  join(root, 'sessions.jsonl'),
  `# v2\n${JSON.stringify(running)}\n${JSON.stringify(stopped)}\n`,
);

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
async function state(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', CLI, 'state', ...args], {
    env: { ...process.env, CCMUX_CONFIG: configPath, CCMUX_STATE_DIR: root, CCMUX_SESSION: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

test('a running session answers with its life, and --since tells the same life from a later one', async () => {
  const before = await state('agent-a', '--since', '2026-09-23T00:30:00Z', '--json');
  expect(before.code).toBe(0);
  const answer = JSON.parse(before.out);
  expect(answer).toMatchObject({
    address: 'host-a:agent-a',
    exists: true,
    running: true,
    lifeStartedAt: '2026-09-23T01:00:00.000Z',
    conversation: { agent: 'claude', id: running.uuid },
    life: 'restarted',
  });
  const after = JSON.parse(
    (await state('agent-a', '--since', '2026-09-23T01:30:00Z', '--json')).out,
  );
  expect(after.life).toBe('same');
});

test('a registered session that is not running is stopped, not missing', async () => {
  const result = await state('agent-b', '--since', '2026-09-23T01:30:00Z', '--json');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ exists: true, running: false, life: 'stopped' });
});

test('an unknown name is "does not exist", with the reason in words', async () => {
  const result = await state('agent-z', '--json');
  expect(result.code).toBe(3);
  expect(JSON.parse(result.out)).toMatchObject({
    exists: false,
    reason: 'no session named agent-z on host-a',
  });
});

test('a question that could not be asked is not reported as a missing session', async () => {
  const unknownMachine = await state('elsewhere:agent-a');
  expect(unknownMachine.code).toBe(1);
  const badTime = await state('agent-a', '--since', 'yesterday');
  expect(badTime.code).toBe(1);
  expect(badTime.err).toContain('--since is not a time');
  const noAddress = await state();
  expect(noAddress.code).toBe(1);
  expect(noAddress.err).toContain('not a managed session');
});
