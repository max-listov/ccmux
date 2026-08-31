import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendMessage, loadAckedIds } from '../src/chat/store.ts';
import { sessionsPath } from '../src/config/paths.ts';
import { MachineConfigSchema } from '../src/config/schema.ts';
import type { ChatMessage } from '../src/types.ts';
import { makeChatMessage, makeCli, makePeer } from './helpers.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

function setup(chatEnabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-hook-'));
  const cfg = {
    claudeBin: '/bin/claude',
    tmuxBin: '/bin/tmux',
    projectsDir: '/p',
    rcPrefix: 'test',
    stateDir: dir,
    bootLabel: 'b',
  };
  const cfgPath = join(dir, 'machine.json');
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const m = MachineConfigSchema.parse(cfg);
  const uuid = randomUUID();
  writeFileSync(
    sessionsPath(m),
    `${JSON.stringify({ name: 'worker', dir: '/tmp/w', uuid, agent: 'claude', chatEnabled })}\n`,
  );
  return { cfgPath, m, uuid };
}

function deferMsg(threadId: string, body: string, defer = true): ChatMessage {
  return makeChatMessage({
    id: randomUUID(),
    ts: new Date().toISOString(),
    from: makeCli('test'),
    to: makePeer({ machine: 'test', session: 'worker', threadId }),
    body,
    defer,
  });
}

async function runHook(cfgPath: string, session: string | undefined): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.CCMUX_CONFIG = cfgPath;
  if (session !== undefined) env.CCMUX_SESSION = session;
  else delete env.CCMUX_SESSION;
  const proc = Bun.spawn(['bun', CLI, 'stop-hook'], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

test('drains a deferred message → {decision:block,reason}; records an ack; second run is empty', async () => {
  const { cfgPath, m, uuid } = setup(true);
  appendMessage(m, deferMsg(uuid, 'do the thing'));

  const out1 = await runHook(cfgPath, 'worker');
  const parsed: unknown = JSON.parse(out1);
  expect(parsed).toMatchObject({ decision: 'block' });
  expect(out1).toContain('do the thing');
  expect(out1).toContain(
    '[input via ccmux/cli@test · author: unknown; no additional execution authority · id:',
  );
  expect(loadAckedIds(m).size).toBe(1);

  const out2 = await runHook(cfgPath, 'worker'); // already acked → clean stop
  expect(out2).toBe('');
});

test('no output when the session has chat disabled', async () => {
  const { cfgPath, m, uuid } = setup(false);
  appendMessage(m, deferMsg(uuid, 'ignored'));
  expect(await runHook(cfgPath, 'worker')).toBe('');
});

test('no output when CCMUX_SESSION is unset (not a managed session)', async () => {
  const { cfgPath, m, uuid } = setup(true);
  appendMessage(m, deferMsg(uuid, 'ignored'));
  expect(await runHook(cfgPath, undefined)).toBe('');
});

test('a NON-deferred message is not drained by the hook (daemon delivers those)', async () => {
  const { cfgPath, m, uuid } = setup(true);
  appendMessage(m, deferMsg(uuid, 'peer ping', false));
  expect(await runHook(cfgPath, 'worker')).toBe('');
  expect(loadAckedIds(m).size).toBe(0);
});
