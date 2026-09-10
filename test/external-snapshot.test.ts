import { afterEach, expect, spyOn, test } from 'bun:test';
import { appendFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ExternalContentTarget,
  EXTERNAL_CONTENT_LIMITS as limits,
} from '../src/external/contentSchema.ts';
import {
  buildContentSnapshot,
  getContentSnapshot,
  publishContentSnapshot,
  validateContentSnapshot,
} from '../src/external/contentSnapshot.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function source(text: string) {
  const root = await mkdtemp('/tmp/ccmux-snapshot-');
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'history.jsonl');
  await writeFile(path, text, { mode: 0o600 });
  const file = await open(path, 'r+');
  cleanup.push(() => file.close());
  const target: ExternalContentTarget = {
    provider: 'codex',
    machine: 'host-a',
    threadId: crypto.randomUUID(),
  };
  const signal = new AbortController().signal;
  return {
    file,
    path,
    target,
    signal,
    build: async () => buildContentSnapshot(file, await file.stat(), path, root, target, signal),
  };
}
const message = (text: string) =>
  `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: text },
  })}\n`;

test('warm pages read no history bytes; changed source verifies only the fixed prefix', async () => {
  const text =
    message('older') +
    `${JSON.stringify({ type: 'tool', data: 'x'.repeat(200000) })}\n`.repeat(8) +
    message('newer');
  const p = await source(text);
  const reads = spyOn(p.file, 'read');
  try {
    const snapshot = await p.build();
    if (!snapshot) throw Error('snapshot absent');
    const chunks = Math.ceil(Buffer.byteLength(text) / limits.chunkBytes);
    expect(reads).toHaveBeenCalledTimes(chunks);
    reads.mockClear();
    expect(await validateContentSnapshot(snapshot, p.file, p.path, p.signal)).toBe(true);
    expect(reads).toHaveBeenCalledTimes(0);
    // Append after capture but before publish is also the initial request's validation path.
    await appendFile(p.path, message('later').repeat(100));
    expect(await validateContentSnapshot(snapshot, p.file, p.path, p.signal)).toBe(true);
    expect(reads).toHaveBeenCalledTimes(chunks);
    expect(snapshot.entries.map((e) => e.text)).toEqual(['older', 'newer']);
    reads.mockClear();
    expect(await validateContentSnapshot(snapshot, p.file, p.path, p.signal)).toBe(true);
    expect(reads).toHaveBeenCalledTimes(0);
  } finally {
    reads.mockRestore();
  }
});

test('snapshot expiry is absolute and missing snapshots cannot be resumed', async () => {
  const p = await source(message('hello'));
  const snapshot = await p.build();
  if (!snapshot) throw Error('snapshot absent');
  publishContentSnapshot(snapshot);
  expect(getContentSnapshot(snapshot.id)).toBe(snapshot);
  const clock = spyOn(Date, 'now').mockReturnValue(snapshot.expires + 1);
  try {
    expect(getContentSnapshot(snapshot.id)).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});

test('source, projection and cancellation budgets fail explicitly', async () => {
  const p = await source('');
  await p.file.truncate(limits.sourceBytes + 1);
  await expect(p.build()).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED', status: 413 });
  await p.file.truncate(0);
  await writeFile(p.path, message('x'.repeat(4096)).repeat(2100));
  await expect(p.build()).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED', status: 413 });
  await expect(
    buildContentSnapshot(
      p.file,
      await p.file.stat(),
      p.path,
      'identity',
      p.target,
      AbortSignal.abort(),
    ),
  ).rejects.toBeDefined();
  // A failed build must release capacity for another reader.
  await writeFile(p.path, message('ok'));
  expect((await p.build())?.entries.map((e) => e.text)).toEqual(['ok']);
});

test('UTF-8 crossing a scan chunk and incomplete tails keep exact authored text', async () => {
  const prefix = JSON.stringify({ type: 'tool', data: '' });
  const noise =
    JSON.stringify({ type: 'tool', data: 'x'.repeat(limits.chunkBytes - prefix.length - 40) }) +
    '\n';
  const visible = 'я🙂'.repeat(100);
  const p = await source(`${noise}${message(visible)}{"unfinished":`);
  const snapshot = await p.build();
  expect(snapshot?.entries.map((e) => e.text)).toEqual([visible]);
  expect(snapshot?.omitted).toBe(2);
});
