import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from 'stitchkit';
import { histFile } from '../src/agent/claude/resume.ts';
import { managedPeer } from '../src/chat/identity.ts';
import {
  answerPeerOperation,
  type ForwardedOperation,
  forwardOperation,
} from '../src/control/peerOperation.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import type { RemoteResult, runPeer } from '../src/fleet/transport.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/session/registry.ts';
import { sentKeysOf } from '../src/session/sentKeys.ts';
import type { MachineConfig, Session } from '../src/types.ts';
import { makeMachine, makeSession } from './helpers.ts';

const THREAD = '66666666-6666-4666-8666-666666666666';
const L = (o: unknown): string => JSON.stringify(o);

/** One machine of the fleet: its own state, its own registry, its own daemon on its own socket. */
async function machine(root: string, rcPrefix: string, fleet: Record<string, string>) {
  const base = join(root, rcPrefix);
  const projectsDir = join(base, 'claude', 'projects');
  const work = join(base, 'work');
  mkdirSync(work, { recursive: true });
  mkdirSync(join(base, 'state'), { recursive: true });
  const m: MachineConfig = makeMachine({
    rcPrefix,
    stateDir: join(base, 'state'),
    projectsDir,
    codexHome: join(base, 'codex'),
    codexSessionsDir: join(base, 'codex', 'sessions'),
    // No session runs: keys are typed into a multiplexer that accepts and does nothing.
    tmuxBin: '/usr/bin/true',
    fleet,
  });
  mkdirSync(join(base, 'codex', 'sessions'), { recursive: true });
  return { m, work, projectsDir };
}

/**
 * How machine A reaches machine B here: what `ccmux _peer-operation` does on B — the same
 * function, asking B's daemon over B's socket — without the hop between them.
 */
function peerOf(
  peers: Record<string, ReturnType<typeof createControlClient>>,
  calls: string[][],
): typeof runPeer {
  return async (_m, machine, _alias, argv, opts) => {
    calls.push([machine, ...argv]);
    const client = peers[machine];
    if (client === undefined) throw new Error(`no machine ${machine} in this fleet`);
    const [, verb, key] = argv;
    if (verb !== '_peer-operation' || key === undefined) throw new Error('not a forwarded call');
    const answer = await answerPeerOperation(key, opts?.stdin ?? '', (operation, input) =>
      (client[operation] as (value: unknown) => Promise<unknown>)(input),
    );
    return {
      code: 0,
      stdout: `${JSON.stringify(answer)}\n`,
      stderr: '',
      transportFailed: false,
      delivery: 'received',
    } satisfies RemoteResult;
  };
}

test("an operation on another machine's session is answered by that machine's daemon", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-peer-operation-')));
  const a = await machine(root, 'host-a', { 'host-b': 'alias-b' });
  const b = await machine(root, 'host-b', { 'host-a': 'alias-a' });
  const session: Session = makeSession({ name: 'agent-b', uuid: THREAD, dir: b.work });
  const path = histFile(b.work, THREAD, b.projectsDir);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `${L({
      type: 'user',
      uuid: 'p-1',
      sessionId: THREAD,
      timestamp: '2026-09-02T10:00:00.000Z',
      cwd: b.work,
      message: { role: 'user', content: [{ type: 'text', text: 'deploy the kestrel' }] },
    })}\n`,
  );
  await writeSessionsUnlocked(b.m, [session]);
  const before = process.env.CCMUX_CONFIG;
  const config = join(root, 'machine-b.json');
  writeFileSync(config, JSON.stringify(b.m));
  process.env.CCMUX_CONFIG = config;
  const publishers = [new ControlPublisher(a.m), new ControlPublisher(b.m)] as const;
  const serverB = createControlServer(b.m, publishers[1]);
  const clientB = createControlClient({ socket: controlSocket(b.m) });
  const calls: string[][] = [];
  const serverA = createControlServer(a.m, publishers[0], undefined, undefined, undefined, {
    runPeer: peerOf({ 'host-b': clientB }, calls),
  });
  const clientA = createControlClient({ socket: controlSocket(a.m) });
  try {
    const target = managedPeer('host-b', session);

    // A whole message of B's session, read on A: B read it, and said who sent it.
    const message = await clientA['message.read']({ address: 'host-b:agent-b', messageId: 'p-1' });
    expect(message.outcome).toBe('resolved');
    expect(message.message?.text).toBe('deploy the kestrel');
    expect(message.message?.sender.verdict).toBe('person');

    // Keys typed on B's session from A are recorded on B, as typed by ccmux — B's own command
    // line, the authority the call arrived under there.
    expect(await clientA['session.keys']({ target, text: '/compact' })).toEqual({
      target,
      accepted: true,
    });
    expect(sentKeysOf(b.m, 'agent-b').map((row) => row.by)).toEqual(['ccmux:host-b:cli']);
    expect(sentKeysOf(a.m, 'agent-b')).toEqual([]);

    // Stopped and removed on B; A's registry was never touched.
    expect(await clientA['session.stop']({ target })).toMatchObject({ target, accepted: true });
    expect(await clientA['session.remove']({ target })).toMatchObject({
      target,
      accepted: true,
      stopped: true,
    });
    expect(loadSessions(b.m)).toEqual([]);
    expect(calls.map((call) => call.slice(0, 4))).toEqual([
      ['host-b', 'ccmux', '_peer-operation', 'message.read'],
      ['host-b', 'ccmux', '_peer-operation', 'session.keys'],
      ['host-b', 'ccmux', '_peer-operation', 'session.stop'],
      ['host-b', 'ccmux', '_peer-operation', 'session.remove'],
    ]);

    // B's refusal comes back under its own code: the session is no longer registered there.
    await expect(clientA['session.stop']({ target })).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
    });
  } finally {
    await clientA.close();
    await clientB.close();
    for (const publisher of publishers) publisher.close();
    for (const server of [serverA, serverB]) {
      await server.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
      await server.observability.close();
    }
    if (before === undefined) delete process.env.CCMUX_CONFIG;
    else process.env.CCMUX_CONFIG = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a machine that does not have the operation refuses it by name', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-peer-operation-old-')));
  const a = await machine(root, 'host-a', { 'host-b': 'alias-b', 'host-c': 'alias-c' });
  const publisher = new ControlPublisher(a.m);
  const answers: Record<string, RemoteResult> = {
    // A release before forwarding: the verb is unknown, so it prints its help and exits 1.
    'host-b': {
      code: 1,
      stdout: 'ccmux — persistent agent sessions\n\nusage: ccmux <command>\n',
      stderr: '',
      transportFailed: false,
      delivery: 'received',
    },
    // A machine whose program forwards, in front of a daemon without the operation.
    'host-c': {
      code: 0,
      stdout: `${JSON.stringify(
        await answerPeerOperation(
          'session.stop',
          JSON.stringify({ target: target('host-c') }),
          () =>
            Promise.reject(
              new ApiError('UNKNOWN_OPERATION', {
                status: 404,
                message: 'No operation session.stop',
              }),
            ),
        ),
      )}\n`,
      stderr: '',
      transportFailed: false,
      delivery: 'received',
    },
  };
  const server = createControlServer(a.m, publisher, undefined, undefined, undefined, {
    runPeer: async (_m, machine) => answers[machine] as RemoteResult,
  });
  const client = createControlClient({ socket: controlSocket(a.m) });
  try {
    for (const peer of ['host-b', 'host-c'])
      await expect(client['session.stop']({ target: target(peer) })).rejects.toMatchObject({
        code: 'UNKNOWN_OPERATION',
        message: expect.stringContaining('session.stop'),
      });
    // A name this machine does not take from another is refused before any daemon is asked.
    const refused = await answerPeerOperation('session.create' as ForwardedOperation, '{}', () => {
      throw new Error('must not be asked');
    });
    expect(refused).toMatchObject({ ok: false, code: 'UNKNOWN_OPERATION' });
  } finally {
    await client.close();
    publisher.close();
    await server.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await server.observability.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function target(machine: string) {
  return managedPeer(machine, makeSession({ name: 'agent-x', uuid: THREAD }));
}

test('the program another machine runs asks this machine’s daemon and prints one answer', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-peer-operation-cli-')));
  const b = await machine(root, 'host-b', {});
  const session: Session = makeSession({ name: 'agent-b', uuid: THREAD, dir: b.work });
  await writeSessionsUnlocked(b.m, [session]);
  const config = join(root, 'machine-b.json');
  writeFileSync(config, JSON.stringify(b.m));
  const publisher = new ControlPublisher(b.m);
  const server = createControlServer(b.m, publisher);
  const run = async (key: string, input: unknown) => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, '../src/cli.ts'), '_peer-operation', key],
      {
        env: { ...process.env, CCMUX_CONFIG: config, CCMUX_SESSION: '', CCMUX_CHAT_CREDENTIAL: '' },
        stdin: new Blob([JSON.stringify(input)]),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, answer: JSON.parse(out.trim()) };
  };
  try {
    const target = managedPeer('host-b', session);
    expect(await run('session.stop', { target })).toEqual({
      code: 0,
      answer: { ok: true, result: expect.objectContaining({ target, accepted: true }) },
    });
    // A refusal is an answer too, under the daemon's code.
    expect(
      await run('session.stop', { target: { ...target, threadId: crypto.randomUUID() } }),
    ).toEqual({
      code: 0,
      answer: expect.objectContaining({ ok: false, code: 'IDENTITY_MISMATCH' }),
    });
    expect(await run('session.stop', { target: 'not a target' })).toEqual({
      code: 0,
      answer: expect.objectContaining({ ok: false, code: 'INVALID_INPUT' }),
    });
  } finally {
    publisher.close();
    await server.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await server.observability.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a caller of this machine's declared service is not carried to another machine", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-peer-operation-service-')));
  const a = await machine(root, 'host-a', { 'host-b': 'alias-b' });
  let asked = 0;
  try {
    await expect(
      forwardOperation(
        a.m,
        { kind: 'remote', alias: 'alias-b', machine: 'host-b', session: 'agent-x' },
        'session.stop',
        { target: target('host-b') },
        { kind: 'service', source: 'ccmux', machine: 'host-a', transport: 'declared-service' },
        undefined,
        async () => {
          asked++;
          throw new Error('must not be asked');
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(asked).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
