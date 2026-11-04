import { afterEach, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ControlPublisher } from '../src/control/publisher.ts';
import {
  CCMUX_CONTROL_CALLER_HEADER,
  createInjectedControlClient,
} from '../src/control/transport/boundary.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import type { ExternalContentTarget } from '../src/external/contentSchema.ts';
import { attributeAuthorship, readExternalMessage } from '../src/external/message.ts';
import { EXTERNAL_MESSAGE_LIMITS } from '../src/external/messageSchema.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { makeMachine, makeSession } from './helpers.ts';

// The record shapes below are the ones a Codex Desktop history carries: `task_started` with the turn's
// attribution, then `item_completed` for each item, a user input being `UserMessage` with its native
// UUID, client id and content parts.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const meta = (id: string) => line({ type: 'session_meta', payload: { id } });
const turn = (turnId: string, trigger?: string) =>
  line({
    type: 'event_msg',
    payload: {
      type: 'task_started',
      turn_id: turnId,
      ...(trigger === undefined ? {} : { turn_attribution: { turn_trigger: trigger } }),
    },
  });
const item = (
  threadId: string,
  turnId: string,
  body: { type: string; id: string; client_id?: string; content?: unknown[] },
) =>
  line({
    timestamp: '2026-11-01T13:15:04.111Z',
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: threadId, turn_id: turnId, item: body },
  });
const userMessage = (threadId: string, turnId: string, id: string, ...content: unknown[]) =>
  item(threadId, turnId, {
    type: 'UserMessage',
    id,
    client_id: 'client-1',
    content: content.length ? content : [{ type: 'text', text: 'hello' }],
  });

async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/ccmux-external-message-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, 'storage');
  await mkdir(join(storage, 'nested'), { recursive: true });
  const m = makeMachine({
    rcPrefix: 'host-a',
    stateDir: join(root, 'state'),
    codexSessionsDir: storage,
    projectsDir: storage,
    externalInventory: true,
  });
  const target: ExternalContentTarget = {
    provider: 'codex',
    machine: m.rcPrefix,
    threadId: crypto.randomUUID(),
  };
  const path = join(storage, 'nested', `rollout-fixture-${target.threadId}.jsonl`);
  await writeFile(path, meta(target.threadId), { mode: 0o600 });
  const read = (messageId: string, override: Partial<ExternalContentTarget> = {}) =>
    readExternalMessage(m, { target: { ...target, ...override }, messageId }, signal());
  return { root, m, target, path, read, thread: target.threadId };
}

test('a message that opened a composer turn resolves whole, with its native identity and submitter', async () => {
  const p = await fixture();
  const id = crypto.randomUUID();
  const long = 'Направления оставляем. '.repeat(500); // ~11.5 k characters, far past one history entry
  await appendFile(
    p.path,
    turn('turn-1', 'composer') +
      userMessage(
        p.thread,
        'turn-1',
        id,
        { type: 'text', text: '\n# Files mentioned by the user:\n' },
        { type: 'local_image', path: '/x.png' },
        { type: 'text', text: long },
      ),
  );
  const result = await p.read(id);
  expect(result.outcome).toBe('resolved');
  expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(result.message).toEqual({
    id,
    clientId: 'client-1',
    turnId: 'turn-1',
    recordedAt: '2026-11-01T13:15:04.111Z',
    text: `\n# Files mentioned by the user:\n${long}`,
    images: 1,
    authorship: {
      verdict: 'person',
      trigger: 'composer',
      position: 'turn-opening',
      reason: 'a person started the turn it opened',
    },
  });
  expect(result.message?.text.length).toBeGreaterThan(4096);
});

test('only the input that opened a turn is attributed; the trigger decides who', async () => {
  const p = await fixture();
  const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
  await appendFile(
    p.path,
    turn('t-composer', 'composer') +
      userMessage(p.thread, 't-composer', ids[0] as string) +
      userMessage(p.thread, 't-composer', ids[1] as string) + // steered into the running turn
      turn('t-queue', 'queue') +
      userMessage(p.thread, 't-queue', ids[2] as string) +
      turn('t-agent', 'app_tool_send_message') +
      userMessage(p.thread, 't-agent', ids[3] as string) +
      turn('t-none') +
      userMessage(p.thread, 't-none', ids[4] as string) +
      userMessage(p.thread, 't-unseen', ids[5] as string),
  );
  const verdicts = [];
  for (const id of ids) {
    const a = (await p.read(id)).message?.authorship;
    verdicts.push([a?.verdict, a?.trigger, a?.position]);
  }
  expect(verdicts).toEqual([
    ['person', 'composer', 'turn-opening'],
    ['unverifiable', 'composer', 'mid-turn'],
    ['unverifiable', 'queue', 'turn-opening'],
    ['not-person', 'app_tool_send_message', 'turn-opening'],
    ['unverifiable', null, 'turn-opening'],
    ['unverifiable', null, 'turn-opening'],
  ]);
});

test('the attribution table: phones and edits are a person, an unknown trigger is never one', () => {
  for (const trigger of ['remote_android', 'remote_ios', 'edit_user_message'])
    expect(attributeAuthorship(trigger, 'turn-opening').verdict).toBe('person');
  for (const trigger of ['automation_heartbeat_scheduled', 'goal', 'resume_interrupted_task'])
    expect(attributeAuthorship(trigger, 'turn-opening').verdict).toBe('not-person');
  for (const trigger of ['queue', 'capacity_retry_manual', 'something_new'])
    expect(attributeAuthorship(trigger, 'turn-opening').verdict).toBe('unverifiable');
  expect(attributeAuthorship('composer', 'mid-turn').verdict).toBe('unverifiable');
});

test('an invented id, an assistant item, a quotation and another thread never resolve', async () => {
  const p = await fixture();
  const real = crypto.randomUUID();
  const assistant = crypto.randomUUID();
  const quoted = crypto.randomUUID();
  const foreign = crypto.randomUUID();
  await appendFile(
    p.path,
    turn('t1', 'composer') +
      userMessage(p.thread, 't1', real, { type: 'text', text: `please check ${quoted}` }) +
      item(p.thread, 't1', { type: 'AgentMessage', id: assistant, content: [] }) +
      item(p.thread, 't1', { type: 'McpToolCall', id: crypto.randomUUID(), content: [] }) +
      userMessage(crypto.randomUUID(), 't1', foreign),
  );
  expect((await p.read(crypto.randomUUID())).outcome).toBe('not-found');
  expect((await p.read(assistant)).outcome).toBe('not-user-input');
  expect((await p.read(quoted)).outcome).toBe('not-found');
  expect((await p.read(foreign)).outcome).toBe('not-found');
  expect((await p.read(real)).message?.text).toBe(`please check ${quoted}`);
  await expect(p.read(real, { machine: 'host-b' })).rejects.toMatchObject({
    code: 'IDENTITY_MISMATCH',
  });
  expect((await p.read(real, { threadId: crypto.randomUUID() })).outcome).toBe('history-absent');
  expect((await p.read(real, { provider: 'claude' })).outcome).toBe('unsupported');
});

test('a message is whole or refused: oversized text, oversized record, unknown parts, two versions', async () => {
  const p = await fixture();
  const [big, huge, odd, twice, partial] = Array.from({ length: 5 }, () => crypto.randomUUID());
  const textOver = 'x'.repeat(EXTERNAL_MESSAGE_LIMITS.textBytes + 1);
  const recordOver = [
    { type: 'image', image_url: 'y'.repeat(EXTERNAL_MESSAGE_LIMITS.recordBytes) },
  ];
  await appendFile(
    p.path,
    turn('t1', 'composer') +
      userMessage(p.thread, 't1', big as string, { type: 'text', text: textOver }) +
      userMessage(p.thread, 't1', huge as string, ...recordOver) +
      userMessage(p.thread, 't1', odd as string, { type: 'audio', data: 'z' }) +
      userMessage(p.thread, 't1', twice as string, { type: 'text', text: 'first' }) +
      userMessage(p.thread, 't1', twice as string, { type: 'text', text: 'second' }) +
      userMessage(p.thread, 't1', partial as string).trimEnd(), // not yet a complete record
  );
  expect((await p.read(big as string)).outcome).toBe('too-large');
  expect((await p.read(huge as string)).outcome).toBe('too-large');
  expect((await p.read(odd as string)).outcome).toBe('unsupported');
  expect((await p.read(twice as string)).outcome).toBe('ambiguous');
  expect((await p.read(partial as string)).outcome).toBe('not-found');
  for (const id of [big, huge, odd, twice]) expect((await p.read(id as string)).message).toBeNull();
});

test('missing, identity-less and managed histories are told apart', async () => {
  const p = await fixture();
  const id = crypto.randomUUID();
  // A history with records but no native item identities (an older client format).
  await appendFile(
    p.path,
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }),
  );
  expect((await p.read(id)).outcome).toBe('unsupported');
  expect((await p.read(id, { threadId: crypto.randomUUID() })).outcome).toBe('history-absent');
  await writeSessionsUnlocked(p.m, [
    makeSession({ name: 'agent-a', agent: 'codex', uuid: p.thread }),
  ]);
  await expect(p.read(id)).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
});

test('local and declared-service clients share the read; it changes nothing and refuses a non-UUID', async () => {
  const p = await fixture();
  const id = crypto.randomUUID();
  await appendFile(p.path, turn('t1', 'composer') + userMessage(p.thread, 't1', id));
  const publisher = new ControlPublisher(p.m);
  const owned = createControlServer(p.m, publisher, undefined, () => p.m);
  const local = createControlClient({ socket: controlSocket(p.m) });
  cleanup.push(async () => {
    await local.close();
    await owned.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    owned.external.close();
    publisher.close();
    await owned.observability.close();
  });
  const service = createInjectedControlClient((url, init) =>
    fetch(String(url), {
      unix: controlSocket(p.m),
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        [CCMUX_CONTROL_CALLER_HEADER]: 'host-b',
      },
    }),
  );
  const before = await readFile(p.path, 'utf8');
  const remote = await service['external.message']({ target: p.target, messageId: id });
  expect(remote.message?.authorship.verdict).toBe('person');
  expect(await local['external.message']({ target: p.target, messageId: id })).toEqual({
    ...remote,
    observedAt: expect.any(String),
  });
  expect(await readFile(p.path, 'utf8')).toBe(before);
  // A byte offset — what `external.history` uses as an entry id — is not a native message id.
  await expect(
    service['external.message']({ target: p.target, messageId: '2048' }),
  ).rejects.toBeDefined();
});

test('a split history: the message is read from the file it was written to, compressed or not', async () => {
  const p = await fixture();
  const { rm: remove } = await import('node:fs/promises');
  await remove(p.path);
  const t0 = Date.parse('2026-10-14T07:49:10.710Z');
  const thread = Bun.randomUUIDv7('hex', t0);
  const segment = Bun.randomUUIDv7('hex', t0 + 7 * 86_400_000);
  const early = Bun.randomUUIDv7('hex', t0 + 86_400_000);
  const late = Bun.randomUUIDv7('hex', t0 + 8 * 86_400_000);
  const dir = join(p.root, 'storage', 'nested');
  await writeFile(
    join(dir, `rollout-a-${thread}.jsonl.zst`),
    Bun.zstdCompressSync(
      meta(thread) + turn('t1', 'remote_ios') + userMessage(thread, 't1', early),
    ),
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, `rollout-b-${thread}_${segment}.jsonl`),
    meta(thread) +
      turn('t9', 'composer') +
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      }) +
      userMessage(thread, 't9', late),
    { mode: 0o600 },
  );
  // A compressed file that does not decode, or decodes to another thread, is not that history.
  const broken = Bun.randomUUIDv7('hex', t0);
  await writeFile(join(dir, `rollout-c-${broken}.jsonl.zst`), 'not zstd', { mode: 0o600 });
  const stranger = Bun.randomUUIDv7('hex', t0);
  await writeFile(
    join(dir, `rollout-d-${stranger}.jsonl.zst`),
    Bun.zstdCompressSync(meta(crypto.randomUUID()) + userMessage(stranger, 't1', early)),
    { mode: 0o600 },
  );
  const read = (messageId: string, threadId = thread) =>
    readExternalMessage(p.m, { target: { ...p.target, threadId }, messageId }, signal());
  expect((await read(late)).message?.authorship.trigger).toBe('composer');
  expect((await read(early)).message?.authorship.trigger).toBe('remote_ios');
  // A non-v7 id cannot be placed in a split history.
  expect((await read(crypto.randomUUID())).outcome).toBe('unsupported');
  // The history reads the file Codex writes now and counts the earlier one it did not read.
  const { readExternalContent } = await import('../src/external/content.ts');
  const page = await readExternalContent(
    p.m,
    { target: { ...p.target, threadId: thread }, cursor: null, limit: 8 },
    signal(),
  );
  expect(page).toMatchObject({ outcome: 'available', earlierFiles: 1, truncated: true });
  expect(page.entries.map((entry) => entry.text)).toEqual(['hello']);
  expect((await read(Bun.randomUUIDv7('hex', t0 + 1000), broken)).outcome).toBe('unavailable');
  expect((await read(early, stranger)).outcome).toBe('unavailable');
});
