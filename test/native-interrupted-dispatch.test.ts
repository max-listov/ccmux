import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type CodexListTurnsParams,
  type CodexTurnsPage,
  findCodexTurnByClientId,
} from 'stitchkit/agent-executor/codex';
import {
  nativeInputDelivered,
  nativeInputFoundByClientId,
  TurnPickup,
} from '../src/agent/claude/native/pickup.ts';
import { NativeProjection } from '../src/agent/claude/native/projection.ts';
import { nativeTranscriptPath } from '../src/context/claude.ts';
import { RuntimeInputSchema, readRuntimeInput, writeRuntimeInput } from '../src/runtime/input.ts';
import type { MachineConfig, Session } from '../src/types.ts';
import { makeMachine } from './helpers.ts';

/**
 * A dispatch cut short mid-flight. The phase file cannot answer whether the turn was sent — it
 * says only that the process died while sending — so the runtime's own transcript is asked, and
 * both wrong answers cost something: one drops a message nobody sent, the other sends a second
 * copy of one already answered.
 */

/** A profile is what the session declares in its env file; the process environment plays no part. */
function conversation(entries: unknown[]): { session: Session; dir: string; m: MachineConfig } {
  const home = mkdtempSync(join(tmpdir(), 'stitchmux-dispatch-'));
  const dir = join(home, 'work');
  mkdirSync(dir, { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  const envFile = join(home, 'profile.env');
  writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${home}\n`);
  const session = {
    name: 'agent-A',
    dir,
    agent: 'claude',
    runtime: 'native',
    uuid: id,
    envFile,
    nativeSession: { id, kind: 'claude' },
  } as unknown as Session;
  const m = makeMachine({ projectsDir: join(home, 'machine-default', 'projects') });
  const path = nativeTranscriptPath(session, m);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return { dir, session, m };
}

const input = (over: Record<string, unknown> = {}) =>
  RuntimeInputSchema.parse({
    messageId: '22222222-2222-4222-8222-222222222222',
    nativeId: 'msg_abc',
    text: 'ship the thing',
    phase: 'dispatching',
    dispatchedAt: '2026-09-01T10:00:00.000Z',
    ...over,
  });

test('a turn present in the transcript after its dispatch counts as delivered', () => {
  const { session, m } = conversation([
    {
      type: 'user',
      timestamp: '2026-09-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'ship the thing' }] },
    },
  ]);
  expect(nativeInputDelivered(m, session, input(), '2026-09-01T10:00:00.000Z')).toBe(true);
});

test('the same words sent before this dispatch are not its receipt', () => {
  const { session, m } = conversation([
    {
      type: 'user',
      timestamp: '2026-09-01T09:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'ship the thing' }] },
    },
  ]);
  // Matching on text alone would read an hour-old turn as an acknowledgement of this one and drop
  // a message that was never sent.
  expect(nativeInputDelivered(m, session, input(), '2026-09-01T10:00:00.000Z')).toBe(false);
});

test('a conversation with no such turn is undelivered, not unknown', () => {
  const { session, m } = conversation([
    {
      type: 'user',
      timestamp: '2026-09-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'something else' }] },
    },
  ]);
  expect(nativeInputDelivered(m, session, input(), '2026-09-01T10:00:00.000Z')).toBe(false);
});

test('a dispatch written before this field existed is judged by when its record was written', () => {
  const { session, m } = conversation([
    {
      type: 'user',
      timestamp: '2026-09-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'ship the thing' }] },
    },
  ]);
  // The whole population this reconciliation exists for is the turns an EARLIER build left in
  // flight, and none of them carries a dispatch time. Judging those undelivered would send every
  // one of them a second time — so the caller supplies the mailbox file's own timestamp, and the
  // answer is the same as for a record that carried it.
  expect(
    nativeInputDelivered(
      m,
      session,
      input({ dispatchedAt: undefined }),
      '2026-09-01T10:00:00.000Z',
    ),
  ).toBe(true);
});

test('an absent transcript means the turn never arrived', () => {
  const { session, m } = conversation([]);
  expect(nativeInputDelivered(m, session, input(), '2026-09-01T10:00:00.000Z')).toBe(false);
});

test('Claude client-id reconcile via stitchkit findInput matches user uuid and ignores assistant uuid', async () => {
  const msgId = '22222222-2222-4222-8222-222222222222';
  const assistantOnly = conversation([
    {
      type: 'assistant',
      uuid: msgId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    },
  ]);
  expect(await nativeInputFoundByClientId(assistantOnly.m, assistantOnly.session, input())).toBe(
    false,
  );

  const userPresent = conversation([
    {
      type: 'user',
      uuid: msgId,
      message: { role: 'user', content: [{ type: 'text', text: 'ship the thing' }] },
    },
  ]);
  expect(await nativeInputFoundByClientId(userPresent.m, userPresent.session, input())).toBe(true);

  const linkPath = join(dirname(userPresent.dir), 'work-symlink');
  symlinkSync(userPresent.dir, linkPath);
  expect(
    await nativeInputFoundByClientId(
      userPresent.m,
      { ...userPresent.session, dir: linkPath },
      input(),
    ),
  ).toBe(true);
});

test('Codex receipt lookup walks subsequent pages and rejects cursor loops', async () => {
  const targetClientId = '33333333-3333-4333-8333-333333333333';
  const pages: Record<string, CodexTurnsPage> = {
    first: {
      data: [
        { id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', clientId: 'other' }] },
      ],
      nextCursor: 'page-2',
    },
    'page-2': {
      data: [
        {
          id: 'turn-2',
          status: 'completed',
          items: [{ type: 'userMessage', clientId: targetClientId }],
        },
      ],
      nextCursor: null,
    },
  };
  const rpc = {
    listTurns: async (params: CodexListTurnsParams) => {
      const page = pages[params.cursor ?? 'first'];
      if (!page) throw new Error('unexpected history cursor');
      return page;
    },
  };
  const found = await findCodexTurnByClientId(rpc, {
    threadId: 'thread-1',
    clientId: targetClientId,
  });
  expect(found?.id).toBe('turn-2');

  const loopingRpc = {
    listTurns: async () => ({ data: [], nextCursor: 'same-cursor' }),
  };
  await expect(
    findCodexTurnByClientId(loopingRpc, { threadId: 'thread-1', clientId: targetClientId }),
  ).rejects.toThrow(/repeated cursor/);
});

test('TurnPickup resolves interrupted Claude dispatch through findInput without resending', async () => {
  const msgId = '44444444-4444-4444-8444-444444444444';
  const { session, m } = conversation([
    {
      type: 'user',
      uuid: msgId,
      message: { role: 'user', content: [{ type: 'text', text: 'ship the thing' }] },
    },
  ]);
  await writeRuntimeInput(m, session, input({ messageId: msgId, phase: 'dispatching' }));
  let startTurnCalls = 0;
  const pickup = new TurnPickup();
  await pickup.run({
    m,
    session,
    projection: new NativeProjection(),
    sdkSession: null,
    selectModel: async () => {},
    setResolvedFiles: () => {},
    startTurn: async () => {
      startTurnCalls += 1;
    },
  });
  expect(startTurnCalls).toBe(0);
  expect(readRuntimeInput(m, session)?.phase).toBe('accepted');
});

test('Claude holds a lost acknowledgement until its exact receipt arrives without another start', async () => {
  const { session, m } = conversation([]);
  const queued = input({ phase: 'queued' });
  await writeRuntimeInput(m, session, queued);
  let starts = 0;
  const target = {
    m,
    session,
    projection: new NativeProjection(),
    sdkSession: null,
    selectModel: async () => {},
    setResolvedFiles: () => {},
    startTurn: async () => {
      starts += 1;
      if (starts === 1) throw new Error('lost acknowledgement');
    },
  };
  await expect(new TurnPickup().run(target)).rejects.toThrow('lost acknowledgement');
  target.projection = new NativeProjection();
  const restarted = new TurnPickup();
  const entry = (uuid: string) =>
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: queued.text },
    });
  const other = entry(crypto.randomUUID());
  const path = nativeTranscriptPath(session, m);
  writeFileSync(path, `${other}\n`);
  await restarted.run(target);
  expect(starts).toBe(1);
  expect(readRuntimeInput(m, session)?.phase).toBe('uncertain');
  await restarted.run(target);
  expect(starts).toBe(1);
  writeFileSync(path, `${other}\n${entry(queued.messageId)}\n`);
  await restarted.run(target);
  expect(readRuntimeInput(m, session)?.phase).toBe('accepted');
  expect(starts).toBe(1);
});
