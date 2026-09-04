import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { managedPeer } from '../src/chat/identity.ts';
import { loadLedger } from '../src/chat/store.ts';
import { sessionsPath } from '../src/config/paths.ts';
import { flushOutbox, loadOutboxAcked } from '../src/fleet/flush.ts';
import { appendOutbound } from '../src/fleet/outbox.ts';
import { runPeer } from '../src/fleet/transport.ts';
import { makeChatMessage, makeCli, makeMachine, makeSession } from './helpers.ts';

const InputSchema = z.object({
  to: z.literal('host-b'),
  argv: z.array(z.string()),
  stdin: z.string().nullable(),
  timeoutMs: z.number(),
});

test('lost remote reply and concurrent outbox retries preserve one receiver envelope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-remote-chat-'));
  const state = join(root, 'receiver');
  mkdirSync(state);
  const receiver = makeMachine({ stateDir: state, rcPrefix: 'host-b', chatEnabled: true });
  const session = makeSession({ name: 'agent-b', dir: state, chatEnabled: true });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(receiver));
  writeFileSync(sessionsPath(receiver), `${JSON.stringify(session)}\n`);
  const env: Record<string, string | undefined> = { ...process.env, CCMUX_CONFIG: config };
  delete env.CCMUX_SESSION;
  delete env.CCMUX_CHAT_CREDENTIAL;
  delete env.CODEX_THREAD_ID;
  const received: string[] = [];
  let loseReply = true;
  const socket = join(root, 'agent.sock');
  const server = Bun.serve({
    unix: socket,
    fetch: async (request) => {
      const input = InputSchema.parse(await request.json());
      expect(input.argv).toEqual(['ccmux', '_chat-receive-v2']);
      const stdin = input.stdin ?? '';
      received.push(stdin);
      const child = Bun.spawn(
        [process.execPath, '--no-env-file', join(import.meta.dir, 'fixtures/receive-chat.ts')],
        {
          env,
          cwd: state,
          stdin: new Response(stdin),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (loseReply) {
        loseReply = false;
        return new Response('{');
      }
      return Response.json({
        code,
        stdout,
        stderr,
        transportFailed: false,
        delivery: 'received',
      });
    },
  });
  try {
    const sender = makeMachine({
      stateDir: join(root, 'sender'),
      rcPrefix: 'host-a',
      remoteTransport: { socket, peers: ['host-b'] },
    });
    const envelope = makeChatMessage({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      from: makeCli('host-a'),
      to: managedPeer('host-b', session),
    });
    const encoded = JSON.stringify(envelope);
    const result = await runPeer(sender, 'host-b', null, ['ccmux', '_chat-receive-v2'], {
      stdin: encoded,
    });
    expect(result).toMatchObject({ transportFailed: true, delivery: 'unknown' });
    expect(loadLedger(receiver)).toEqual([envelope]);
    appendOutbound(sender, { kind: 'msg', envelope, result: { ok: false, detail: 'unknown' } });
    await Promise.all([flushOutbox(sender), flushOutbox(sender)]);
    expect(received).toHaveLength(3);
    expect(received.every((bytes) => bytes === encoded)).toBe(true);
    expect(loadLedger(receiver)).toEqual([envelope]);
    expect(loadOutboxAcked(sender).has(envelope.id)).toBe(true);
    await flushOutbox(sender);
    expect(received).toHaveLength(3);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
