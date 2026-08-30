import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAppMessagePersisted } from '../src/agent/codex/appPickup.ts';
import type { CodexAppRpc } from '../src/agent/codex/appServer.ts';
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

type RpcHandler = (method: string, params: unknown) => unknown | Promise<unknown>;
const fakeRpc = (handler: RpcHandler): CodexAppRpc => ({
  request: async (method, params) => handler(method, params),
  close() {},
});

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
  expect(
    currentCodexAppThreadId({
      CODEX_THREAD_ID: 'not-a-uuid',
      CODEX_APP_TOOLS_PIPE_PATH: '/tmp/tools.sock',
    }),
  ).toBeNull();
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
  const peer = await resolveCodexAppPeer(makeMachine(), UUID, async () =>
    fakeRpc((method) => {
      expect(method).toBe('thread/read');
      return { thread: thread({ name: 'Readable title' }) };
    }),
  );
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
        fakeRpc((method) => {
          if (method === 'thread/read') return { thread: value };
          started = true;
          throw new Error('must not mutate');
        }),
    );
    expect(result.delivered).toBe(false);
    expect(started).toBe(false);
  }
});

test('notLoaded resumes, revalidates idle, and starts one turn with immutable message id', async () => {
  const messageId = randomUUID();
  const calls: Array<{ method: string; params: unknown }> = [];
  let reads = 0;
  const result = await deliverCodexAppMessage(
    makeMachine(),
    makeChatMessage({ id: messageId, to: makeAppPeer({ machine: 'prod' }) }),
    'framed payload',
    async () =>
      fakeRpc((method, params) => {
        calls.push({ method, params });
        if (method === 'thread/read')
          return {
            thread:
              reads++ === 0
                ? thread({ status: { type: 'notLoaded' }, canAcceptDirectInput: null })
                : thread(),
          };
        if (method === 'thread/resume') return { thread: thread() };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        throw new Error(`unexpected ${method}`);
      }),
  );
  expect(result).toEqual({ delivered: true, duplicate: false, turnId: 'turn-1' });
  expect(calls.map((call) => call.method)).toEqual([
    'thread/read',
    'thread/resume',
    'thread/read',
    'turn/start',
  ]);
  expect(calls.at(-1)?.params).toMatchObject({ threadId: UUID, clientUserMessageId: messageId });
});

test('persisted client message proof closes restart window without a second turn/start', async () => {
  const messageId = randomUUID();
  let started = false;
  const result = await deliverCodexAppMessage(
    makeMachine(),
    makeChatMessage({ id: messageId, to: makeAppPeer({ machine: 'prod' }) }),
    'payload',
    async () =>
      fakeRpc(() => {
        started = true;
        throw new Error('duplicate turn');
      }),
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
