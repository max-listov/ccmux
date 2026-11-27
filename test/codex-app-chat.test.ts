import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcError } from 'stitchkit/agent-executor';
import {
  createFakeCodexAppServer,
  createStubCodexControlConnection,
} from 'stitchkit/agent-executor/testing';
import { codexAppMessagePersisted } from '../src/agent/codex/appPickup.ts';
import {
  currentCodexAppThreadId,
  deliverCodexAppMessage,
  resolveCodexAppPeer,
} from '../src/chat/codexApp.ts';
import { formatChatInjection } from '../src/chat/format.ts';
import {
  chatPrincipalKey,
  codexAppAddress,
  humanLabel,
  principalLabel,
} from '../src/chat/identity.ts';
import { formatForTg } from '../src/chat/telegram.ts';
import { makeAppPeer, makeChatMessage, makeMachine, makePeer, UUID } from './helpers.ts';

const thread = (over: Record<string, unknown> = {}) => ({
  id: UUID,
  name: 'App task',
  source: 'appServer',
  status: { type: 'idle' },
  canAcceptDirectInput: true,
  turns: [],
  ...over,
});

test('Desktop tool environment becomes an exact App thread identity, never anonymous CLI', () => {
  expect(
    currentCodexAppThreadId({
      CODEX_THREAD_ID: UUID,
      CODEX_APP_TOOLS_PIPE_PATH: '/tmp/tools.sock',
    }),
  ).toBe(UUID);
  expect(
    currentCodexAppThreadId({
      CODEX_THREAD_ID: UUID,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
    }),
  ).toBe(UUID);
  // Runtime origin flags differ between App hosts; the shared daemon's exact thread/read is the
  // provenance check. A bare UUID is only a candidate until that check succeeds.
  expect(currentCodexAppThreadId({ CODEX_THREAD_ID: UUID })).toBe(UUID);
  expect(() =>
    currentCodexAppThreadId({
      CODEX_THREAD_ID: 'not-a-uuid',
      CODEX_APP_TOOLS_PIPE_PATH: '/tmp/tools.sock',
    }),
  ).toThrow('valid CODEX_THREAD_ID');
  expect(currentCodexAppThreadId({})).toBeNull();
  for (const env of [
    { CODEX_THREAD_ID: '' },
    { CODEX_APP_TOOLS_PIPE_PATH: '/tmp/tools.sock' },
    { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' },
  ]) {
    expect(() => currentCodexAppThreadId(env)).toThrow('valid CODEX_THREAD_ID');
  }
});

test('App identity equality ignores title changes and pins machine + UUID', () => {
  const a = makeAppPeer({ name: 'Before' });
  const renamed = makeAppPeer({ name: 'After' });
  expect(chatPrincipalKey(a)).toBe(chatPrincipalKey(renamed));
  expect(chatPrincipalKey(makeAppPeer({ machine: 'host-b' }))).not.toBe(chatPrincipalKey(a));
  expect(principalLabel(a)).toContain(`codex-app@host-a:Before#${UUID}`);
  expect(codexAppAddress(UUID)).toBe(`app/${UUID}`);
});

test('App sender keeps a readable mirror label and an exact pinned reply command', () => {
  const msg = makeChatMessage({ from: makeAppPeer(), to: makePeer({ session: 'worker' }) });
  expect(humanLabel(msg.from)).toBe('host-a:App task');
  expect(formatForTg(msg)).toContain('[host-a:App task → host-a:worker]');
  expect(formatChatInjection(msg, { cli: 'ccmux', reply: { replyable: true } })).toContain(
    `reply: ccmux msg host-a:app/${UUID} --to-agent codex --to-thread ${UUID}`,
  );
});

test('resolve verifies the exact thread and preserves the title only as a snapshot', async () => {
  const peer = await resolveCodexAppPeer(makeMachine(), UUID, async () => ({
    readThread: async (params) => {
      expect(params).toEqual({ threadId: UUID, includeTurns: false });
      return { thread: thread({ name: 'Readable title' }) };
    },
    close: async () => {},
  }));
  expect(peer).toEqual(makeAppPeer({ machine: 'prod', name: 'Readable title' }));
});

test('active, approval, systemError and no-direct-input states hold fail-closed', async () => {
  const cases = [
    thread({ status: { type: 'active', activeFlags: ['waitingForApproval'] } }),
    thread({ status: { type: 'active', activeFlags: ['waitingForUserInput'] } }),
    thread({ status: { type: 'systemError' } }),
    thread({ canAcceptDirectInput: false }),
  ];
  for (const value of cases) {
    let started = false;
    const result = await deliverCodexAppMessage(
      makeMachine(),
      makeChatMessage({ id: randomUUID(), to: makeAppPeer({ machine: 'prod' }) }),
      'payload',
      async () =>
        createStubCodexControlConnection({
          readThread: async () => ({ thread: value }),
          startThreadTurn: async () => {
            started = true;
            throw new Error('must not mutate');
          },
        }),
    );
    expect(result.delivered).toBe(false);
    expect(started).toBe(false);
  }
});

test('notLoaded resumes, revalidates idle, and starts one turn with immutable message id', async () => {
  const messageId = randomUUID();
  const root = mkdtempSync(join(tmpdir(), 'ccmux-delivery-'));
  const dir = join(root, 'app-server-control');
  mkdirSync(dir, { mode: 0o700 });
  let reads = 0;
  const server = await createFakeCodexAppServer({
    socketPath: join(dir, 'app-server-control.sock'),
    handlers: {
      'thread/read': () => ({
        thread:
          reads++ === 0
            ? thread({ status: { type: 'notLoaded' }, canAcceptDirectInput: null })
            : thread(),
      }),
      'thread/resume': () => ({ thread: thread() }),
      'turn/start': () => ({ turn: { id: 'turn-1' } }),
    },
  });
  try {
    const result = await deliverCodexAppMessage(
      makeMachine({ codexHome: root }),
      makeChatMessage({ id: messageId, to: makeAppPeer({ machine: 'prod' }) }),
      'framed payload',
    );
    expect(result).toEqual({ delivered: true, duplicate: false, turnId: 'turn-1' });
    expect(server.requests.map((call) => call.method)).toEqual([
      'initialize',
      'thread/read',
      'thread/resume',
      'thread/read',
      'turn/start',
    ]);
    expect(server.requests.at(-1)?.params).toMatchObject({
      threadId: UUID,
      clientUserMessageId: messageId,
      input: [{ type: 'text', text: 'framed payload' }],
    });
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persisted client message proof closes restart window without a second turn/start', async () => {
  const messageId = randomUUID();
  let started = false;
  const result = await deliverCodexAppMessage(
    makeMachine(),
    makeChatMessage({ id: messageId, to: makeAppPeer({ machine: 'prod' }) }),
    'payload',
    async () => {
      started = true;
      throw new Error('duplicate delivery opened a connection');
    },
    async () => true,
  );
  expect(result).toEqual({ delivered: true, duplicate: true, turnId: null });
  expect(started).toBe(false);
});

test('restart proof finds only an exact persisted client_id, including across a stream chunk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-app-pickup-'));
  const messageId = randomUUID();
  const path = join(dir, `rollout-${UUID}.jsonl`);
  const exact = `"client_id":"${messageId}"`;
  const prefix = 'x'.repeat(65_536 - Math.floor(exact.length / 2));
  writeFileSync(path, `${prefix}${exact}\n{"message":"${randomUUID()}"}\n`);

  const machine = makeMachine({ codexSessionsDir: dir });
  expect(await codexAppMessagePersisted(machine, UUID, messageId)).toBe(true);

  const bodyOnlyId = randomUUID();
  writeFileSync(path, `{"message":"${bodyOnlyId}"}\n`, { flag: 'a' });
  expect(await codexAppMessagePersisted(machine, UUID, bodyOnlyId)).toBe(false);
});

test('a provider refusal is a hold with its own sentence, whichever call it comes from', async () => {
  const call = (failure: Error, refusing = 'turn/start') =>
    deliverCodexAppMessage(
      makeMachine(),
      makeChatMessage({ id: randomUUID(), to: makeAppPeer({ machine: 'prod' }) }),
      'payload',
      async () =>
        createStubCodexControlConnection({
          readThread: async () => ({
            thread: thread(refusing === 'thread/resume' ? { status: { type: 'notLoaded' } } : {}),
          }),
          resumeThread: async () => {
            throw failure;
          },
          startThreadTurn: async () => {
            throw failure;
          },
        }),
    );
  // The thread reports idle while another App client holds its writer, so this is the only place
  // that truth arrives. Read as an exception it becomes a warning on every delivery pass, for as
  // long as the other client keeps working.
  const refused = await call(new JsonRpcError(-32000, 'thread 0000 already has an active writer'));
  expect(refused).toEqual({
    delivered: false,
    reason: 'App Server RPC failed: thread 0000 already has an active writer',
  });
  // A thread another client is working in reports notLoaded, so the refusal actually arrives from
  // the resume — the call it is easiest to forget, and the one that produced the warning storm.
  const busy = new JsonRpcError(-32000, 'thread 0000 already has an active writer');
  expect(await call(busy, 'thread/resume')).toEqual({
    delivered: false,
    reason: `App Server RPC failed: ${busy.message}`,
  });
  // Anything that is not the provider's answer is still a failure, not a polite refusal.
  await expect(call(new Error('Codex App Server connection closed'))).rejects.toThrow(
    'connection closed',
  );
});
