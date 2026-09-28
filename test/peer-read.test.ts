import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
writeFileSync(config, JSON.stringify({ stateDir: root, rcPrefix: 'host-config' }));
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
    tmuxBin: Bun.which('tmux') ?? 'tmux',
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
  const list = await peerRead('list');
  expect(list.code).toBe(0);
  expect(list.answer).toMatchObject({ rcPrefix: 'host-config', sessions: { refs: [] } });
  expect((await peerRead('chat-log')).code).toBe(2);
  expect((await peerRead('list', '--known')).code).toBe(2);
});
