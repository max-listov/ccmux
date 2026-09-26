import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { terminalMenu } from '../src/agent/claude/prompts.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { tmuxArgv } from '../src/tmux/argv.ts';
import { capturePane, newSession } from '../src/tmux/tmux.ts';
import { run } from '../src/util/spawn.ts';
import { makeMachine, makePeer, makeSession } from './helpers.ts';

test('terminal menu parser exposes only a complete known option set', () => {
  const text = '❯ No, disable external imports\n  Yes, allow\nEnter to confirm · Esc to cancel';
  expect(terminalMenu(text)?.options.map((o) => o.id)).toEqual(['0', '1']);
  expect(terminalMenu(text)?.selected).toBe(0);
  expect(terminalMenu('❯ 1. Something unknown')?.options).toEqual([]);
  expect(terminalMenu('❯ hello')).toBeNull();
  expect(terminalMenu(text.replace('Yes, allow', 'Yes, maybe'))?.options).toEqual([]);
});

test('real terminal submits a nondefault option once and refuses stale observations without keys', async () => {
  const root = mkdtempSync('/tmp/ccmux-menu-');
  const m = makeMachine({
    stateDir: root,
    rcPrefix: 'host-a',
    tmuxBin: Bun.which('tmux'),
    tmuxSocket: `menu-${crypto.randomUUID()}`,
  });
  const session = makeSession({ name: 'worker', dir: root });
  const target = makePeer();
  const state = join(root, 'state'),
    log = join(root, 'keys');
  writeFileSync(state, 'menu');
  writeFileSync(log, '');
  await writeSessionsUnlocked(m, [session]);
  await newSession(m, session.name, root, [
    process.execPath,
    join(import.meta.dir, 'fixtures/terminalMenu.ts'),
    state,
    log,
  ]);
  const publisher = new ControlPublisher(m);
  const server = createControlServer(m, publisher);
  const client = createControlClient({ socket: controlSocket(m) });
  const prompts = {
    read: (target: ReturnType<typeof makePeer>) => client['terminal.prompt']({ target }),
    respond: (input: Parameters<(typeof client)['terminal.respond']>[0], signal: AbortSignal) =>
      client['terminal.respond'].withOptions(input, { signal }),
  };
  const signal = AbortSignal.timeout(10_000);
  async function observe() {
    while (!signal.aborted) {
      const result = await prompts.read(target);
      if (result.observationId) return result.observationId;
      await Bun.sleep(20);
    }
    throw new Error('menu did not render');
  }
  try {
    const stale = await observe();
    writeFileSync(state, 'composer');
    while (!(await capturePane(m, session.name, 10)).includes('Composer ready')) {
      signal.throwIfAborted();
      await Bun.sleep(20);
    }
    await expect(
      prompts.respond({ target, observationId: stale, optionId: '1' }, signal),
    ).rejects.toThrow('current terminal menu');
    expect(readFileSync(log, 'utf8')).toBe('');
    writeFileSync(state, 'menu');
    const observationId = await observe();
    expect(await prompts.respond({ target, observationId, optionId: '1' }, signal)).toMatchObject({
      outcome: 'submitted',
    });
    await expect(prompts.respond({ target, observationId, optionId: '1' }, signal)).rejects.toThrow(
      'current terminal menu',
    );
    const deadline = Date.now() + 1000;
    while (!readFileSync(log, 'utf8').includes('\\r') && Date.now() < deadline) await Bun.sleep(20);
    const keys = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe('\r');
  } finally {
    await client.close();
    publisher.close();
    await server.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await server.observability.close();
    await run(tmuxArgv(m, 'kill-server'));
    rmSync(root, { recursive: true, force: true });
  }
});
