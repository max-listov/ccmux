import { afterEach, expect, test } from 'bun:test';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlServer } from '../src/control/server.ts';
import {
  CCMUX_CONTROL_SERVICE_INGRESS_PATH,
  CCMUX_CONTROL_SERVICE_PREFIX,
  CCMUX_CONTROL_SERVICE_REVISION,
  ControlServiceOperationSchema,
  createCcmuxControlServiceClient,
} from '../src/control/serviceDescriptor.ts';
import { readExternalContent, readExternalContentCapabilities } from '../src/external/content.ts';
import {
  ExternalContentReadSchema,
  type ExternalContentTarget,
} from '../src/external/contentSchema.ts';
import { makeMachine, makeSession } from './helpers.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
const meta = (id: string) => `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`;
const message = (text: string, role = 'assistant') =>
  `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: 'output_text', text }] },
  })}\n`;
async function fixture(provider: 'codex' | 'claude' = 'codex') {
  const root = await realpath(await mkdtemp('/tmp/ccmux-external-content-'));
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
    provider,
    machine: m.rcPrefix,
    threadId: crypto.randomUUID(),
  };
  const path = join(
    storage,
    'nested',
    provider === 'codex' ? `rollout-fixture-${target.threadId}.jsonl` : `${target.threadId}.jsonl`,
  );
  await writeFile(path, provider === 'codex' ? meta(target.threadId) : '', { mode: 0o600 });
  const read = (cursor: string | null = null, limit = 32) =>
    readExternalContent(m, { target, cursor, limit }, signal());
  return { root, storage, m, target, path, read };
}

test('external pages retain exact identity and authored text, not internal prompts or tools', async () => {
  const p = await fixture();
  await appendFile(
    p.path,
    message('fixture-internal-secret', 'developer') +
      message('hello', 'user') +
      message('world') +
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', arguments: 'fixture-tool-secret' },
      }) +
      '\n',
  );
  const page = await p.read();
  expect(page.outcome).toBe('available');
  expect(page.target).toEqual(p.target);
  expect(page.entries.map((row) => row.text)).toEqual(['hello', 'world']);
  expect(JSON.stringify(page)).not.toContain('fixture-internal-secret');
  expect(JSON.stringify(page)).not.toContain('fixture-tool-secret');
  expect(JSON.stringify(page)).not.toContain(p.root);
  expect(page.omittedRecords).toBe(3);
  const capability = await readExternalContentCapabilities(p.m, p.target, signal());
  expect(capability.history.outcome).toBe('available');
  expect(Object.values(capability.control).every((item) => !item.supported)).toBe(true);
  expect(await readFile(p.path, 'utf8')).toContain('fixture-internal-secret');
});

test('backward pagination crosses byte windows without losing the boundary record', async () => {
  const p = await fixture();
  const expected = Array.from({ length: 160 }, (_, i) => `${i}:${'x'.repeat(3000)}`);
  await appendFile(p.path, expected.map((text) => message(text)).join(''));
  const pages: string[][] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 20; n++) {
    const page = await p.read(cursor, 17);
    expect(page.outcome).toBe('available');
    expect(page.entries.length).toBeLessThanOrEqual(17);
    pages.unshift(page.entries.map((row) => row.text));
    if (page.nextCursor === null) break;
    expect(page.nextCursor).not.toBe(cursor);
    cursor = page.nextCursor;
  }
  expect(pages.flat()).toEqual(expected);
});

test('empty, absent, changed and malformed cursors are distinct', async () => {
  const p = await fixture();
  expect(await p.read()).toMatchObject({ outcome: 'available', entries: [], nextCursor: null });
  const missing = { ...p.target, threadId: crypto.randomUUID() };
  expect(
    await readExternalContent(p.m, { target: missing, cursor: null, limit: 1 }, signal()),
  ).toMatchObject({ outcome: 'history-absent', revision: null });
  await appendFile(p.path, message('one') + message('two'));
  const page = await p.read(null, 1);
  expect(page.nextCursor).not.toBeNull();
  await appendFile(p.path, message('three'));
  expect(await p.read(page.nextCursor)).toMatchObject({ outcome: 'stale', entries: [] });
  await expect(p.read('broken')).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  await expect(
    readExternalContent(p.m, { target: missing, cursor: page.nextCursor, limit: 1 }, signal()),
  ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
});

test('large native metadata is bounded separately and never exposed as conversation', async () => {
  const p = await fixture();
  await writeFile(
    p.path,
    `${JSON.stringify({ type: 'session_meta', payload: { id: p.target.threadId, instructions: 'private'.repeat(10000) } })}\n${message('visible')}`,
  );
  const page = await p.read();
  expect(page.entries.map((entry) => entry.text)).toEqual(['visible']);
  expect(JSON.stringify(page)).not.toContain('private');
});

test('external reads refuse managed identities, foreign hosts, disabled access and writable files', async () => {
  const p = await fixture();
  await expect(
    readExternalContent(
      p.m,
      { target: { ...p.target, machine: 'host-b' }, cursor: null, limit: 1 },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  await expect(
    readExternalContent(
      { ...p.m, externalInventory: false },
      { target: p.target, cursor: null, limit: 1 },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await chmod(p.path, 0o666);
  await expect(p.read()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await chmod(p.path, 0o600);
  await writeSessionsUnlocked(p.m, [makeSession({ agent: 'codex', uuid: p.target.threadId })]);
  await expect(p.read()).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  expect(
    ExternalContentReadSchema.safeParse({ target: p.target, path: '/arbitrary' }).success,
  ).toBe(false);
});

test('symlink storage is not followed and mismatched native metadata fails closed', async () => {
  const p = await fixture();
  await writeFile(p.path, meta(crypto.randomUUID()) + message('forbidden'));
  expect(await p.read()).toMatchObject({ outcome: 'unavailable', entries: [] });
  await rm(p.path);
  const outside = join(p.root, 'outside');
  await writeFile(outside, meta(p.target.threadId) + message('forbidden'));
  await symlink(outside, p.path);
  expect(await p.read()).toMatchObject({ outcome: 'history-absent', entries: [] });
});

test('partial/oversized records are bounded and never prevent cursor progress', async () => {
  const p = await fixture();
  await appendFile(
    p.path,
    `${message('older') + message('x'.repeat(400000)) + message('newer')}{"partial":`,
  );
  const first = await p.read();
  expect(first.entries.map((row) => row.text)).toEqual(['newer']);
  expect(first.truncated).toBe(true);
  const older = await p.read(first.nextCursor);
  expect(older.nextCursor).not.toBe(first.nextCursor);
  const oldest = await p.read(older.nextCursor);
  expect(oldest.nextCursor).toBeNull();
  expect([...older.entries, ...oldest.entries].map((row) => row.text)).toEqual(['older']);
  await appendFile(p.path, `true}\n${message('y'.repeat(5000))}`);
  const text = await p.read(null, 1);
  expect(text.entries[0]?.text.length).toBe(4096);
  expect(text.entries[0]?.truncated).toBe(true);
});

test('Claude content uses record identity and excludes synthetic context', async () => {
  const p = await fixture('claude');
  const row = (sessionId: string, isMeta: boolean) =>
    `${JSON.stringify({
      type: 'assistant',
      sessionId,
      isMeta,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'authored' },
          { type: 'thinking', thinking: 'private' },
        ],
      },
    })}\n`;
  await appendFile(
    p.path,
    row(p.target.threadId, false) + row(p.target.threadId, true) + row(crypto.randomUUID(), false),
  );
  const page = await p.read();
  expect(page.entries.map((entry) => entry.text)).toEqual(['authored']);
  expect(JSON.stringify(page)).not.toContain('private');
});

test('real local and declared-service readers share one nonmutating external operation', async () => {
  const p = await fixture();
  await appendFile(p.path, message('live transcript'));
  const publisher = new ControlPublisher(p.m);
  let current = p.m;
  const owned = createControlServer(p.m, publisher, undefined, () => current);
  const local = createControlClient({ socket: controlSocket(p.m) });
  cleanup.push(async () => {
    await local.close();
    await owned.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    owned.external.close();
    publisher.close();
    await owned.observability.close();
  });
  const service = createCcmuxControlServiceClient(async (url, init) => {
    const operation = ControlServiceOperationSchema.parse(
      new URL(String(url)).pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
    );
    return fetch(`http://ccmux.local${CCMUX_CONTROL_SERVICE_INGRESS_PATH}`, {
      unix: controlSocket(p.m),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        id: crypto.randomUUID(),
        caller: 'host-b',
        service: 'ccmux.control',
        revision: CCMUX_CONTROL_SERVICE_REVISION,
        operation,
        payload: init?.body,
      }),
    });
  });
  const before = await readFile(p.path, 'utf8');
  const page = await service.externalHistory({ target: p.target });
  expect(page.entries[0]?.text).toBe('live transcript');
  expect((await local['external.history']({ target: p.target })).revision).toBe(page.revision);
  expect((await service.externalCapabilities({ target: p.target })).control.message.supported).toBe(
    false,
  );
  expect(await readFile(p.path, 'utf8')).toBe(before);
  current = { ...p.m, externalInventory: false };
  await expect(service.externalHistory({ target: p.target })).rejects.toMatchObject({
    code: 'CONFIG_CHANGED',
  });
  await expect(local['external.capabilities']({ target: p.target })).rejects.toMatchObject({
    code: 'CONFIG_CHANGED',
  });
  expect(await service.runtimes({})).toBeDefined();
  current = { ...p.m, codexSessionsDir: p.root };
  await expect(local['external.history']({ target: p.target })).rejects.toMatchObject({
    code: 'CONFIG_CHANGED',
  });
  current = p.m;
  expect((await service.externalHistory({ target: p.target })).outcome).toBe('available');
});
