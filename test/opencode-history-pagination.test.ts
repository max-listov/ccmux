import '../src/agent/index.ts';
import { expect, test } from 'bun:test';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { openCodeContextApi } from '../src/context/opencode.ts';
import { makeMachine, makeSession } from './helpers.ts';

function message(id: number, count: number) {
  return {
    info: { id: `msg_${id}`, sessionID: 'ses_parts', role: 'user', time: { created: id } },
    parts: Array.from({ length: count }, (_, i) => ({
      id: `part_${id}_${i}`,
      type: 'text',
      text: `text ${id}/${i}`,
    })),
  };
}
function fixture(data: ReturnType<typeof message>[]) {
  const calls: URL[] = [];
  const m = makeMachine({ stateDir: `/tmp/ccmux-unused-history-${crypto.randomUUID()}` });
  const s = makeSession({
    agent: 'opencode',
    runtime: 'native',
    registrationGeneration: crypto.randomUUID(),
    nativeSession: { runtime: 'opencode', id: 'ses_parts', version: '1.18.27' },
  });
  const client = createOpencodeClient({
    baseUrl: 'http://native.invalid',
    throwOnError: true,
    fetch: Object.assign(
      async (input: Request | string | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push(url);
        const id = url.pathname.split('/message/')[1];
        if (id !== undefined) {
          const row = data.find((item) => item.info.id === id);
          return row === undefined ? new Response(null, { status: 404 }) : Response.json(row);
        }
        const before = url.searchParams.get('before');
        const end =
          before === null
            ? data.length
            : data.findIndex((item) => `opaque-${item.info.id}` === before);
        const start = Math.max(0, end - Number(url.searchParams.get('limit')));
        const oldest = data[start];
        return Response.json(data.slice(start, end), {
          headers:
            start > 0 && oldest !== undefined
              ? { 'X-Next-Cursor': `opaque-${oldest.info.id}` }
              : {},
        });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  return { api: openCodeContextApi(m, s, client), calls };
}

async function all(f: ReturnType<typeof fixture>, limit = 64) {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await f.api.history(
      { limit, ...(cursor === undefined ? {} : { cursor }) },
      AbortSignal.timeout(1000),
    );
    expect(page.entries.length).toBeLessThanOrEqual(limit);
    expect(page.omittedItems).toBe(0);
    pages.push(page.entries.map((item) => item.itemId));
    if (page.nextCursor === null) {
      expect(page.completeness).toBe('complete');
      return pages.reverse().flat();
    }
    expect(page.completeness).toBe('more');
    cursor = page.nextCursor;
  }
  throw new Error('history did not terminate');
}

test('64 messages with two parts retain all 128 identities including the newest answer', async () => {
  const data = Array.from({ length: 64 }, (_, i) => message(i, 2));
  expect(await all(fixture(data))).toEqual(data.flatMap((row) => row.parts.map((part) => part.id)));
});

test('one large message pages every part at the requested entry limit', async () => {
  const row = message(1, 150);
  expect(await all(fixture([row]), 32)).toEqual(row.parts.map((part) => part.id));
});

test('pending exact identities survive appended messages and parts without duplicates', async () => {
  const data = [message(1, 150)];
  const f = fixture(data);
  const first = await f.api.history({ limit: 64 }, AbortSignal.timeout(1000));
  expect(first.entries[0]?.itemId).toBe('part_1_86');
  if (first.nextCursor === null) throw new Error('continuation missing');
  data[0]?.parts.push({ id: 'part_appended', type: 'text', text: 'new' });
  data.push(message(2, 1));
  const second = await f.api.history(
    { limit: 64, cursor: first.nextCursor },
    AbortSignal.timeout(1000),
  );
  expect(second.entries.map((item) => item.itemId)).toEqual(
    Array.from({ length: 64 }, (_, i) => `part_1_${i + 22}`),
  );
  expect(second.entries.some((item) => item.itemId === 'part_appended')).toBe(false);
});

test('pending parts finish before the next opaque upstream page', async () => {
  const data = Array.from({ length: 70 }, (_, i) => message(i, 3));
  expect(await all(fixture(data))).toEqual(data.flatMap((row) => row.parts.map((part) => part.id)));
});

test('a removed anchor, invalid cursor and wrong native identity fail honestly', async () => {
  const data = [message(1, 100)];
  const f = fixture(data);
  const first = await f.api.history({ limit: 64 }, AbortSignal.timeout(1000));
  if (first.nextCursor === null) throw new Error('continuation missing');
  data[0]?.parts.splice(35, 1);
  await expect(
    f.api.history({ limit: 64, cursor: first.nextCursor }, AbortSignal.timeout(1000)),
  ).rejects.toThrow('cursor is no longer current');
  await expect(
    f.api.history({ limit: 64, cursor: 'invalid' }, AbortSignal.timeout(1000)),
  ).rejects.toThrow('cursor is invalid');
  const wrong = message(2, 1);
  wrong.info.sessionID = 'ses_someone_else';
  await expect(
    fixture([wrong]).api.history({ limit: 64 }, AbortSignal.timeout(1000)),
  ).rejects.toThrow('identity mismatch');
});

test('empty message parts preserve the upstream cursor instead of pretending to be the origin', async () => {
  const data = [message(1, 1), message(2, 0)];
  expect(await all(fixture(data), 1)).toEqual(['part_1_0']);
});

test('a dense native page keeps a bounded identity-only cursor and reads only its needed suffix', async () => {
  const data = Array.from({ length: 64 }, (_, i) => {
    const row = message(i, 100);
    row.info.id = `msg_${String(i).padStart(26, '0')}`;
    for (const [j, part] of row.parts.entries())
      part.id = `prt_${String(i * 100 + j).padStart(26, '0')}`;
    return row;
  });
  const f = fixture(data);
  const first = await f.api.history({ limit: 64 }, AbortSignal.timeout(1000));
  if (first.nextCursor === null) throw new Error('continuation missing');
  expect(first.nextCursor.length).toBeLessThanOrEqual(8192);
  expect(Buffer.from(first.nextCursor, 'base64url').toString()).not.toContain('text ');
  const before = f.calls.length;
  const second = await f.api.history(
    { limit: 64, cursor: first.nextCursor },
    AbortSignal.timeout(1000),
  );
  expect(second.entries).toHaveLength(64);
  expect(second.omittedItems).toBe(0);
  expect(f.calls.length - before).toBeLessThanOrEqual(8);
});
