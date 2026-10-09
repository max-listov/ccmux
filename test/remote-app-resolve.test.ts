import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadLedger } from '../src/chat/ledger.ts';
import { loadOutbox } from '../src/fleet/outbox.ts';
import { communicationAuthorizationFile } from './communication-fixture.ts';
import { makeMachine, UUID } from './helpers.ts';

const InputSchema = z.object({
  to: z.literal('host-b'),
  argv: z.array(z.string()),
  stdin: z.string().nullable(),
});
const RpcSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

test('real resolve CLI through the remote adapter refuses before admission, and accepts only the exact App identity', async () => {
  const root = mkdtempSync('/tmp/car-');
  const home = join(root, 'c');
  const directory = join(home, 'app-server-control');
  mkdirSync(directory, { recursive: true });
  let mode: 'refusal' | 'mismatch' | 'success' = 'refusal';
  const reason = `Owner rejected exact thread: ${'detail '.repeat(40)}final reason`;
  const methods: string[] = [];
  const provider = Bun.serve({
    unix: join(directory, 'app-server-control.sock'),
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const request = RpcSchema.parse(JSON.parse(String(raw)));
        methods.push(request.method);
        if (request.id === undefined) return;
        if (request.method === 'initialize') {
          ws.send(JSON.stringify({ id: request.id, result: {} }));
          return;
        }
        expect(request.method).toBe('thread/read');
        expect(request.params).toEqual({ threadId: UUID, includeTurns: false });
        ws.send(
          JSON.stringify(
            mode === 'refusal'
              ? { id: request.id, error: { code: -32600, message: reason } }
              : {
                  id: request.id,
                  result: {
                    thread: {
                      id: mode === 'mismatch' ? crypto.randomUUID() : UUID,
                      name: 'Exact fixture',
                      source: 'appServer',
                      status: { type: 'active', activeFlags: [] },
                      canAcceptDirectInput: false,
                    },
                  },
                },
          ),
        );
      },
    },
  });
  const receiver = makeMachine({ stateDir: join(root, 'r'), rcPrefix: 'host-b', codexHome: home });
  const receiverConfig = join(root, 'receiver.json');
  writeFileSync(receiverConfig, JSON.stringify(receiver));
  const calls: string[][] = [];
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of [
    'CCMUX_SESSION',
    'CCMUX_CHAT_CREDENTIAL',
    'CODEX_THREAD_ID',
    'CODEX_SESSION_ID',
    'CODEX_APP_TOOLS_PIPE_PATH',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  ])
    delete env[name];
  const adapter = Bun.serve({
    unix: join(root, 'adapter.sock'),
    async fetch(request) {
      const input = InputSchema.parse(await request.json());
      calls.push(input.argv);
      const receive = input.argv[1] === '_chat-receive-v2';
      expect(input.argv).toEqual(
        receive ? ['ccmux', '_chat-receive-v2'] : ['ccmux', '_codex-app-resolve', UUID],
      );
      const child = Bun.spawn(
        [
          process.execPath,
          '--no-env-file',
          receive
            ? join(import.meta.dir, 'fixtures/receive-chat.ts')
            : join(import.meta.dir, '../src/cli.ts'),
          ...(receive ? [] : input.argv.slice(1)),
        ],
        {
          cwd: root,
          env: { ...env, CCMUX_CONFIG: receiverConfig },
          stdin: new Response(input.stdin ?? ''),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return Response.json({ code, stdout, stderr, transportFailed: false, delivery: 'received' });
    },
  });
  const sender = makeMachine({
    stateDir: join(root, 's'),
    rcPrefix: 'host-a',
    remoteTransport: { socket: join(root, 'adapter.sock'), peers: ['host-b'] },
  });
  const senderConfig = join(root, 'sender.json');
  writeFileSync(senderConfig, JSON.stringify(sender));
  const send = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        join(import.meta.dir, 'fixtures/msg.ts'),
        `host-b:app/${UUID}`,
        'isolated fixture message',
        '--communication-authorization',
        communicationAuthorizationFile,
      ],
      {
        cwd: root,
        env: { ...env, CCMUX_CONFIG: senderConfig },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  try {
    const refused = await send();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('[provider-refused] at thread/read, RPC -32600');
    expect(refused.stderr).toContain(reason);
    mode = 'mismatch';
    const mismatch = await send();
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain('[identity-mismatch]');
    expect(calls).toHaveLength(2);
    expect(calls.every((argv) => argv[1] === '_codex-app-resolve')).toBe(true);
    expect(loadLedger(receiver)).toHaveLength(0);
    expect(loadLedger(sender)).toHaveLength(0);
    expect(loadOutbox(sender)).toHaveLength(0);
    mode = 'success';
    const accepted = await send();
    expect(accepted.code).toBe(0);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual(['ccmux', '_chat-receive-v2']);
    expect(loadLedger(receiver)).toHaveLength(1);
    expect(loadOutbox(sender)).toHaveLength(1);
    expect(loadLedger(receiver)[0]?.to).toMatchObject({
      machine: 'host-b',
      kind: 'codex-app',
      threadId: UUID,
    });
    expect(
      methods.every((method) => ['initialize', 'initialized', 'thread/read'].includes(method)),
    ).toBe(true);
  } finally {
    adapter.stop(true);
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
