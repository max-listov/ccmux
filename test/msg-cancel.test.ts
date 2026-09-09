import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_CREDENTIAL_ENV, rotateChatCredential } from '../src/chat/auth.ts';
import { buildEnvelope } from '../src/chat/compose.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { loadAckedIds, loadLedger, pendingConditional } from '../src/chat/store.ts';
import { chatAuthPath, outboxPath, sessionsPath } from '../src/config/paths.ts';
import { MachineConfigSchema } from '../src/config/schema.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { communicationAuthorizationFile } from './communication-fixture.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// Two chat-enabled router sessions (each may relay / arm watchdogs) + a worker target.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-cancel-'));
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
  const row = (name: string, extra: object) =>
    JSON.stringify({
      name,
      dir: '/tmp/x',
      uuid: randomUUID(),
      agent: 'claude',
      chatEnabled: true,
      ...extra,
    });
  const m = MachineConfigSchema.parse(cfg);
  writeFileSync(
    sessionsPath(m),
    `${row('router', { promptModules: ['router'] })}\n${row('router2', { promptModules: ['router'] })}\n${row('worker', {})}\n`,
  );
  for (const session of loadSessions(m)) rotateChatCredential(m, session);
  return { cfgPath, m };
}

async function runMsg(
  cfgPath: string,
  session: string | undefined,
  args: string[],
  stdin?: string,
): Promise<{ code: number; out: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.CCMUX_CONFIG = cfgPath;
  if (session !== undefined) {
    env.CCMUX_SESSION = session;
    const m = MachineConfigSchema.parse(JSON.parse(await Bun.file(cfgPath).text()));
    const managed = loadSessions(m).find((item) => item.name === session);
    if (managed !== undefined)
      env[CHAT_CREDENTIAL_ENV] = (await Bun.file(chatAuthPath(m, managed.name)).text()).trim();
  } else delete env.CCMUX_SESSION;
  const proc = Bun.spawn(
    ['bun', CLI, 'msg', '--communication-authorization', communicationAuthorizationFile, ...args],
    {
      env,
      stdin: stdin !== undefined ? new Response(stdin) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

test("msg cancel <task> tombstones this sender's undelivered mail for that task", async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 't1', 'watchdog']);
  // one pending conditional before cancel
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 't1' }).length).toBe(1);
  const { code, out } = await runMsg(cfgPath, 'router', ['cancel', 't1']);
  expect(code).toBe(0);
  expect(out).toContain('cancelled 1');
  // gone from pending; the ledger message still exists but is now acked-as-cancel
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 't1' }).length).toBe(0);
});

test('re-arming --after with the same (from,to,task) REPLACES the prior pending — no duplicate watchdog', async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 't2', 'arm 1']);
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 't2', 'arm 2']);
  const pend = pendingConditional(loadLedger(m), loadAckedIds(m), { task: 't2' });
  expect(pend.length).toBe(1); // only the latest survives
  expect(pend[0]?.body).toBe('arm 2');
  // the ledger holds both; the first was tombstoned
  expect(loadLedger(m).filter((x) => x?.task === 't2').length).toBe(2);
});

test("cancel is scoped to the sender — one router can't cancel another's watchdog", async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 'shared', 'mine']);
  const { out } = await runMsg(cfgPath, 'router2', ['cancel', 'shared']); // different sender
  expect(out).toContain('cancelled 0');
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 'shared' }).length).toBe(1); // untouched
});

test('cancel with no task → usage, exit 1', async () => {
  const { cfgPath } = setup();
  const { code, out } = await runMsg(cfgPath, 'router', ['cancel']);
  expect(code).toBe(1);
  expect(out).toContain('usage: ccmux msg cancel');
});

test('dedup replace only fires with a --task — same target, no task, keeps both pending', async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', 'no-task a']);
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', 'no-task b']);
  const worker = loadSessions(m).find((session) => session.name === 'worker');
  if (worker === undefined) throw new Error('worker fixture missing');
  expect(
    pendingConditional(loadLedger(m), loadAckedIds(m), { to: managedPeer(m.rcPrefix, worker) })
      .length,
  ).toBe(2);
});

test('--after + --interrupt prints the trap note but still sends', async () => {
  const { cfgPath, m } = setup();
  const { code, out } = await runMsg(cfgPath, 'router', [
    'worker',
    '--after',
    '600',
    '--interrupt',
    '--task',
    't3',
    'both',
  ]);
  expect(code).toBe(0);
  expect(out).toContain('--after with --interrupt');
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 't3' }).length).toBe(1);
});

test('stdin body: echo … | ccmux msg <to> reads the piped text', async () => {
  const { cfgPath, m } = setup();
  const { code } = await runMsg(cfgPath, 'router', ['worker'], 'piped body here');
  expect(code).toBe(0);
  expect(loadLedger(m).at(-1)?.body).toBe('piped body here');
});

test('cancel names the immediate mail it could not withdraw, so its zero is not read as "nothing waiting"', async () => {
  const { cfgPath, m } = setup();
  // `--interrupt` is what makes a letter immediate; ordinary mail waits for a turn boundary and is
  // therefore conditional, which cancel does withdraw.
  await runMsg(cfgPath, 'router', [
    'worker',
    '--interrupt',
    '--task',
    't4',
    'already overtaken by events',
  ]);
  const { code, out } = await runMsg(cfgPath, 'router', ['cancel', 't4']);
  expect(code).toBe(0);
  // Nothing conditional to tombstone — and a bare zero here reads as an empty queue while the
  // letter is still on its way, which is exactly the conclusion a sender acts on.
  expect(out).toContain('cancelled 0');
  expect(out).toContain("1 immediate message(s) for 't4' are still on their way");
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 't4' }).length).toBe(0);
});

test('cancel says it cannot reach mail that went to another machine, instead of a bare zero', async () => {
  const { cfgPath, m } = setup();
  const router = loadSessions(m).find((row) => row.name === 'router');
  if (router === undefined) throw new Error('fixture lost its sender');
  // A cross-machine letter lives in the RECIPIENT machine's ledger; here only the outbox record of
  // having sent it exists — which is exactly why cancel finds nothing to tombstone.
  const envelope = buildEnvelope(
    managedPeer(m.rcPrefix, router),
    { ...managedPeer(m.rcPrefix, router), machine: 'host-b', session: 'worker' },
    'sent across the fleet',
    { task: 't5', defer: true, onBehalfOf: null, notBefore: null },
  );
  writeFileSync(
    outboxPath(m),
    `${JSON.stringify({ kind: 'msg', envelope, result: { ok: true, detail: '' } })}\n`,
  );
  const { out } = await runMsg(cfgPath, 'router', ['cancel', 't5']);
  expect(out).toContain('cancelled 0');
  expect(out).toContain("1 message(s) for 't5' went to another machine");
});
