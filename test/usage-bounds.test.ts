import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  EMPTY_STATS,
  indexTranscript,
  transcriptIndexPath,
} from '../src/agent/transcript/transcriptIndex.ts';
import { aggregateUsage } from '../src/usage/aggregate.ts';
import { readUsageFile } from '../src/usage/file.ts';
import {
  emptyUsage,
  USAGE_SLICE_BYTES,
  type UsageFact,
  UsageQuerySchema,
} from '../src/usage/schema.ts';
import { UsageStore } from '../src/usage/store.ts';

const roots: string[] = [];
const indexes: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const path of indexes.splice(0)) fs.rmSync(path, { force: true });
});
function fixture() {
  const root = fs.mkdtempSync('/tmp/ccmux-usage-bounds-');
  roots.push(root);
  return root;
}
function fact(id: string): UsageFact {
  return {
    id,
    runtime: 'claude',
    model: `model-${id}`,
    provider: null,
    at: '2026-01-01T00:00:00.000Z',
    observedAt: '2026-01-01T00:00:01.000Z',
    scope: 'message',
    mode: 'replacement',
    epoch: 'native',
    identity: 'native',
    inputIncludesCache: false,
    outputIncludesReasoning: null,
    cost: null,
    metrics: { ...emptyUsage(), inputTokens: 1 },
  };
}

test('bounded query construction resumes with concurrent append/correction and warm reads write nothing', () => {
  const store = new UsageStore(join(fixture(), 'usage.sqlite'));
  try {
    store.transaction(() => {
      for (let i = 0; i < 1200; i++) store.put(fact(String(i)));
    });
    const query = UsageQuerySchema.parse({ limit: 100 });
    const first = aggregateUsage(store, query);
    expect(first.building).toBe(true);
    expect(first.self.observations).toBe(500);
    store.put({ ...fact('0'), metrics: { ...emptyUsage(), inputTokens: 5 } });
    store.put(fact('1200'));
    expect(aggregateUsage(store, query).self.values.inputTokens).toBe(1004);
    const ready = aggregateUsage(store, query);
    expect(ready.building).toBe(false);
    expect(ready.self.values.inputTokens).toBe(1205);
    const changes = () =>
      z.object({ n: z.number() }).parse(store.db.query('SELECT total_changes() AS n').get()).n;
    const before = changes();
    let cursor: string | null = null;
    const names = new Set<string | null>();
    let pages = 0;
    do {
      const page = aggregateUsage(store, { ...query, cursor });
      expect(Buffer.byteLength(JSON.stringify(page.buckets))).toBeLessThanOrEqual(64 * 1024);
      expect(page.buckets.length).toBeGreaterThan(0);
      for (const bucket of page.buckets) {
        expect(names.has(bucket.model)).toBe(false);
        names.add(bucket.model);
      }
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(100);
    } while (cursor);
    expect(names.size).toBe(1201);
    expect(changes()).toBe(before);
    expect(
      aggregateUsage(store, { ...query, timezone: 'Asia/Tokyo', cursor: ready.nextCursor }).reset,
    ).toBe(true);
  } finally {
    store.close();
  }
});

test('cold file work is byte bounded, survives UTF-8 and partial writes; warm usage does not read history', () => {
  const path = join(fixture(), 'history.jsonl');
  indexes.push(transcriptIndexPath(path, 'claude'));
  const record = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: {
      id: 'one',
      role: 'assistant',
      content: [{ type: 'text', text: 'я'.repeat(USAGE_SLICE_BYTES * 0.75) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
  fs.writeFileSync(path, record);
  const q = UsageQuerySchema.parse({});
  const cold = readUsageFile('agent', path, 'claude', q, true);
  expect(cold.indexedBytes).toBe(USAGE_SLICE_BYTES);
  expect(cold.state).toBe('building');
  expect(cold.self.values.inputTokens).toBeNull();
  readUsageFile('agent', path, 'claude', q, true);
  fs.appendFileSync(path, '\n');
  const complete = readUsageFile('agent', path, 'claude', q, true);
  expect(complete.self.values.inputTokens).toBe(10);
  expect(complete.state).toBe('ready');
  const reads = spyOn(fs, 'readSync');
  try {
    expect(readUsageFile('agent', path, 'claude', q).self.values.inputTokens).toBe(10);
    expect(reads).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
  }
  const old = join(fixture(), 'old.jsonl');
  fs.renameSync(path, old);
  fs.writeFileSync(path, `${record.replace('"input_tokens":10', '"input_tokens":20')}\n`);
  readUsageFile('agent', path, 'claude', q, true);
  expect(readUsageFile('agent', path, 'claude', q, true).self.values.inputTokens).toBe(20);
});

test('persistence failure is visible and a failed scan commits neither counts nor checkpoint', () => {
  const path = join(fixture(), 'history.jsonl');
  indexes.push(transcriptIndexPath(path, 'claude'));
  fs.writeFileSync(
    path,
    '{"type":"assistant","message":{"id":"one","usage":{"input_tokens":10}}}\n',
  );
  expect(() =>
    indexTranscript(path, 'claude', () => {
      throw new Error('injected persistence boundary');
    }),
  ).toThrow('injected persistence boundary');
  const store = new UsageStore(transcriptIndexPath(path, 'claude'));
  try {
    expect([...store.facts()]).toHaveLength(0);
    expect(store.read('index', z.unknown())).toBeNull();
  } finally {
    store.close();
  }
  expect(indexTranscript(path, 'claude', () => EMPTY_STATS)?.totalLines).toBe(1);
  const failed = spyOn(UsageStore.prototype, 'put').mockImplementation(() => {
    throw new Error('write refused');
  });
  fs.appendFileSync(
    path,
    '{"type":"assistant","message":{"id":"two","usage":{"input_tokens":20}}}\n',
  );
  try {
    const result = readUsageFile('agent', path, 'claude', UsageQuerySchema.parse({}), true);
    expect(result.state).toBe('failed');
    expect(result.reason).toBe('accounting-unavailable');
  } finally {
    failed.mockRestore();
  }
  expect(
    readUsageFile('agent', path, 'claude', UsageQuerySchema.parse({}), true).self.values
      .inputTokens,
  ).toBe(30);
});

test('independent processes serialize the same cold checkpoint and restart from the committed offset', async () => {
  const path = join(fixture(), 'history.jsonl');
  indexes.push(transcriptIndexPath(path, 'claude'));
  fs.writeFileSync(
    path,
    `${Array.from({ length: 600 }, (_, i) => JSON.stringify({ type: 'assistant', message: { id: String(i), usage: { input_tokens: 1 } } })).join('\n')}\n`,
  );
  const module = join(import.meta.dir, '../src/agent/transcript/transcriptIndex.ts');
  const script = `import {indexTranscript,EMPTY_STATS} from ${JSON.stringify(module)};
    let count=0;const result=indexTranscript(${JSON.stringify(path)},'claude',lines=>{count+=lines.length;return {...EMPTY_STATS,messages:lines.length};});
    console.log(JSON.stringify({count,total:result.totalLines}));`;
  const scan = async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    return z.object({ count: z.number(), total: z.number() }).parse(JSON.parse(stdout));
  };
  const results = await Promise.all([scan(), scan()]);
  // Both answer the whole file. One of them writes the checkpoint; the other either waits for it and
  // reads it (count 0) or, when the writer's first pass outlasts the busy timeout — a loaded
  // machine — reads the file in memory without writing (count 600). It used to fail there instead,
  // with "database is locked". That only one checkpoint was committed is what the next two scans
  // show: each starts from the committed offset.
  expect(results.map((r) => r.total)).toEqual([600, 600]);
  expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(expect.arrayContaining([600]));
  for (const { count } of results) expect([0, 600]).toContain(count);
  fs.appendFileSync(
    path,
    '{"type":"assistant","message":{"id":"last","usage":{"input_tokens":1}}}\n',
  );
  expect(await scan()).toEqual({ count: 1, total: 601 });
  expect(await scan()).toEqual({ count: 0, total: 601 });
});

test('a reader behind a writer that has committed nothing yet reads the file itself', () => {
  const path = join(fixture(), 'history.jsonl');
  const index = transcriptIndexPath(path, 'claude');
  indexes.push(index);
  fs.writeFileSync(
    path,
    `${Array.from({ length: 600 }, (_, i) => JSON.stringify({ type: 'assistant', message: { id: String(i), usage: { input_tokens: 1 } } })).join('\n')}\n`,
  );
  // Another process's first pass: the schema committed, the write lock held, no index yet.
  const holder = new UsageStore(index);
  holder.db.exec('BEGIN IMMEDIATE');
  try {
    let count = 0;
    const result = indexTranscript(path, 'claude', (lines) => {
      count += lines.length;
      return { ...EMPTY_STATS, messages: lines.length };
    });
    // Past the busy timeout it answers the whole file from the file — it used to throw "database is
    // locked" — and writes nothing: the holder records the index itself.
    expect({ total: result?.totalLines, count }).toEqual({ total: 600, count: 600 });
  } finally {
    holder.db.exec('ROLLBACK');
    holder.close();
  }
  const reader = new UsageStore(index);
  try {
    expect(reader.db.query("SELECT 1 FROM sqlite_master WHERE name='facts'").get()).not.toBeNull();
    expect(reader.read('index', z.unknown())).toBeNull();
  } finally {
    reader.close();
  }
});
