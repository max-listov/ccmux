import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { makeMachine } from './helpers.ts';

// A fleet reader on another machine runs `ccmux _peer-read` here. The answer is the daemon's, built
// with its caches warm; the command only relays it. Which side answered is told apart by the
// machine label: the daemon under test is `host-served`, the config the command reads says
// `host-config`.
const root = mkdtempSync('/tmp/ccmux-peer-read-');
afterAll(() => rmSync(root, { recursive: true, force: true }));
const config = join(root, 'machine.json');
// `claudeBin` because the machine config requires one and a CI runner has no provider installed.
writeFileSync(
  config,
  JSON.stringify({ stateDir: root, rcPrefix: 'host-config', claudeBin: process.execPath }),
);
const cli = join(import.meta.dir, '..', 'src', 'cli.ts');

async function peerRead(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, '_peer-read', ...args], {
    env: { ...process.env, CCMUX_CONFIG: config },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, answer: code === 0 ? JSON.parse(stdout) : null };
}

test('the daemon answers a peer read and the command only relays it', async () => {
  const m = makeMachine({
    stateDir: root,
    rcPrefix: 'host-served',
    tmuxBin: Bun.which('tmux') ?? '/usr/bin/tmux',
  });
  const publisher = new ControlPublisher(m);
  const owned = createControlServer(m, publisher);
  try {
    const list = await peerRead('list');
    expect(list.code).toBe(0);
    expect(list.answer).toMatchObject({
      rcPrefix: 'host-served',
      sessions: { refs: [], items: {} },
    });
    const log = await peerRead('chat-log', '-n', '30', '--known', 'aaaaaaaaaaaaaaaa');
    expect(log.code).toBe(0);
    expect(log.answer).toMatchObject({
      machines: [{ machine: 'host-served', ok: true }],
      rows: { refs: [], items: {} },
    });
  } finally {
    publisher.close();
    owned.external.close();
    await owned.server.shutdown({ gracePeriodMs: 200 });
    await owned.observability.close();
  }
});

test('with no daemon the same answer is built here, and a malformed request is refused', async () => {
  // A daemon that died leaves its socket file: listen, then die without closing it.
  rmSync(join(root, 'control', 'api.sock'), { force: true });
  mkdirSync(join(root, 'control'), { recursive: true, mode: 0o700 });
  const socket = JSON.stringify(join(root, 'control', 'api.sock'));
  const dead = Bun.spawn([
    process.execPath,
    '-e',
    `Bun.listen({ unix: ${socket}, socket: { data() {} } }); process.kill(process.pid, 'SIGKILL');`,
  ]);
  await dead.exited;
  expect(existsSync(join(root, 'control', 'api.sock'))).toBe(true);
  const list = await peerRead('list');
  expect({ code: list.code, stderr: list.code === 0 ? '' : list.stderr }).toEqual({
    code: 0,
    stderr: '',
  });
  expect(list.answer).toMatchObject({ rcPrefix: 'host-config', sessions: { refs: [] } });
  expect((await peerRead('chat-log')).code).toBe(2);
  expect((await peerRead('list', '--known')).code).toBe(2);
});

test('warm peer reads retain every session field without running tmux and relay the same external snapshot', async () => {
  const { collectRows } = await import('../src/inventory/rows.ts');
  const { listAnswer } = await import('../src/fleet/peerRead.ts');
  const { writeSessionsUnlocked } = await import('../src/session/registry.ts');
  const { makeSession } = await import('./helpers.ts');
  const { packListAnswer } = await import('../src/fleet/peerRead.ts');
  const { createControlClient } = await import('../src/control/transport/client.ts');
  const m = makeMachine({ stateDir: root, rcPrefix: 'host-served', tmuxBin: '/no-such-tmux' });
  const sessions = [
    makeSession({ name: 'working', dir: root }),
    makeSession({ name: 'idle', dir: root, uuid: crypto.randomUUID() }),
    makeSession({ name: 'prompt', dir: root, uuid: crypto.randomUUID() }),
    makeSession({ name: 'stopped', dir: root, uuid: crypto.randomUUID() }),
    makeSession({ name: 'archive', dir: root, uuid: crypto.randomUUID(), archived: true }),
  ];
  await writeSessionsUnlocked(m, sessions);
  const created = new Map([
    ['working', 100],
    ['idle', 100],
    ['prompt', 100],
  ]);
  const agentPanes = new Map([
    ['working', '%10'],
    ['idle', '%11'],
    ['prompt', '%12'],
  ]);
  const rows = await collectRows(m, {
    observation: {
      created,
      agentPanes,
      panes: new Map([
        ['working', 'esc to interrupt'],
        ['idle', '───\n❯ \n? for shortcuts\n'],
        [
          'prompt',
          'Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n2. No, exit',
        ],
      ]),
    },
  });
  expect(rows.map((row) => row.state)).toEqual(['working', 'idle', 'idle', 'stopped', 'stopped']);
  expect(rows.find((row) => row.session.name === 'prompt')?.atPrompt).toBe('trust this folder');
  const publisher = new ControlPublisher(m);
  const owned = createControlServer(m, publisher, undefined, () => m, undefined, {
    peerRows: () => rows,
  });
  const client = createControlClient({ socket: join(root, 'control', 'api.sock') });
  try {
    const expected = packListAnswer(listAnswer(m, rows), new Set());
    const actual = await peerRead('list');
    expect(actual.code).toBe(0);
    expect(actual.answer.sessions).toEqual(Object(expected).sessions);
    const direct = await client['external.list']();
    const worker = Bun.spawn(
      [process.execPath, 'src/commands/controlExternalEntry.ts', 'control', 'external', '--json'],
      { env: { ...process.env, CCMUX_CONFIG: config }, stdout: 'pipe', stderr: 'pipe' },
    );
    const text = await new Response(worker.stdout).text();
    const external = { code: await worker.exited, answer: JSON.parse(text) };
    expect(external.code).toBe(0);
    expect(external.answer).toEqual(direct);
    expect((await peerRead('external', '--known', 'aaaaaaaaaaaaaaaa')).code).toBe(2);
  } finally {
    await client.close();
    publisher.close();
    owned.external.close();
    await owned.server.shutdown({ gracePeriodMs: 200 });
    await owned.observability.close();
    await writeSessionsUnlocked(m, []);
  }
});

test('external relay preserves the full CLI refusal on a dead socket and rejects unowned arguments', async () => {
  const invoke = async (entry: string, args: string[]) => {
    const child = Bun.spawn([process.execPath, entry, ...args], {
      env: { ...process.env, CCMUX_CONFIG: config },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, error, code };
  };
  const relay = join(import.meta.dir, '../src/commands/controlExternalEntry.ts');
  const args = ['control', 'external', '--json'];
  const full = await invoke(cli, args);
  const light = await invoke(relay, args);
  expect(full.code).toBe(1);
  expect(light.code).toBe(full.code);
  expect(light.out).toBe(full.out);
  expect(full.error).toContain('before request dispatch');
  expect(light.error).toBe(full.error);
  expect((await invoke(relay, [...args, '--watch'])).code).toBe(2);
});
