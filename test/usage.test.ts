import { afterEach, expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_STATS, indexTranscript } from '../src/agent/transcriptIndex.ts';
import { aggregateUsage } from '../src/usage/aggregate.ts';
import { readUsageFile } from '../src/usage/file.ts';
import { parseUsageRecord } from '../src/usage/normalize.ts';
import {
  emptyUsage,
  type UsageFact,
  UsageFactSchema,
  UsageQuerySchema,
} from '../src/usage/schema.ts';
import { UsageStore } from '../src/usage/store.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-usage-'));
  roots.push(root);
  return root;
}
const query = () => UsageQuerySchema.parse({});
function fact(id: string, input: number | null, extra: Partial<UsageFact> = {}): UsageFact {
  return {
    id,
    runtime: 'claude',
    model: 'model-a',
    provider: null,
    at: '2026-01-02T12:00:00.000Z',
    observedAt: '2026-01-02T12:00:01.000Z',
    scope: 'message',
    mode: 'replacement',
    epoch: 'native-a',
    inputIncludesCache: false,
    outputIncludesReasoning: null,
    metrics: { ...emptyUsage(), inputTokens: input },
    cost: null,
    identity: 'native',
    ...extra,
  };
}
function withStore(run: (store: UsageStore) => void) {
  const store = new UsageStore(join(fixture(), 'usage.sqlite'));
  try {
    run(store);
  } finally {
    store.close();
  }
}
const claude = (id: string, input: number, output = 5) =>
  JSON.stringify({
    type: 'assistant',
    uuid: id,
    timestamp: '2026-01-02T12:00:00.000Z',
    message: {
      id,
      role: 'assistant',
      model: 'model-a',
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
      usage: { input_tokens: input, output_tokens: output },
    },
  });

test('Claude display blocks and replay charge one native message; corrections replace the contribution', () => {
  const path = join(fixture(), 'history.jsonl');
  writeFileSync(path, `${claude('m1', 10)}\n${claude('m1', 10)}\n`);
  const first = readUsageFile('host-a:agent-a', path, 'claude', query(), true);
  expect(first.state).toBe('ready');
  expect(first.self.values.inputTokens).toBe(10);
  expect(first.self.values.outputTokens).toBe(5);
  appendFileSync(path, `${claude('m1', 12, 6)}\n`);
  expect(readUsageFile('host-a:agent-a', path, 'claude', query(), true).self.values).toMatchObject({
    inputTokens: 12,
    outputTokens: 6,
  });
});

test('Codex usage events are accounted independently of display response items', () => {
  const path = join(fixture(), 'history.jsonl');
  const event = (n: number, at: string) =>
    JSON.stringify({
      type: 'event_msg',
      timestamp: at,
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: n, output_tokens: 5, total_tokens: n + 5 } },
      },
    });
  writeFileSync(
    path,
    `${[
      event(100, '2026-01-01T00:00:00Z'),
      event(150, '2026-01-02T00:00:00Z'),
      event(150, '2026-01-02T00:00:00Z'),
    ].join('\n')}\n`,
  );
  const result = readUsageFile('host-a:app/example', path, 'codex', query(), true);
  expect(result.self.values.inputTokens).toBe(150);
  expect(result.unattributed.values.inputTokens).toBe(100);
  expect(result.buckets.find((b) => b.day === '2026-01-02')?.values.inputTokens).toBe(50);
});

test('missing metrics stay null; reported zero is measured; invalid numeric values are refused', () => {
  withStore((store) => {
    store.put(fact('missing', null));
    let result = aggregateUsage(store, query());
    expect(result.self.values.inputTokens).toBeNull();
    expect(result.self.measured.inputTokens).toBe(0);
    store.put(fact('zero', 0));
    result = aggregateUsage(store, query());
    expect(result.self.values.inputTokens).toBe(0);
    expect(result.self.measured.inputTokens).toBe(1);
  });
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])
    expect(UsageFactSchema.safeParse(fact('invalid', value)).success).toBe(false);
});

test('cache and reasoning are independent dimensions, not extra total tokens', () => {
  withStore((store) => {
    store.put(
      fact('one', 10, {
        metrics: {
          inputTokens: 10,
          outputTokens: 6,
          cacheReadTokens: 8,
          cacheCreationTokens: 2,
          reasoningTokens: 4,
          totalTokens: 16,
        },
      }),
    );
    expect(aggregateUsage(store, query()).self.values).toEqual({
      inputTokens: 10,
      outputTokens: 6,
      cacheReadTokens: 8,
      cacheCreationTokens: 2,
      reasoningTokens: 4,
      totalTokens: 16,
    });
  });
});

test('revision replaces a previous day and model; stale query cursor resets', () => {
  withStore((store) => {
    store.put(fact('one', 10));
    store.put(fact('two', 20, { at: '2026-01-03T00:00:00.000Z' }));
    const first = aggregateUsage(store, UsageQuerySchema.parse({ limit: 1 }));
    expect(first.nextCursor).not.toBeNull();
    store.put(fact('one', 15, { at: '2026-01-04T00:00:00.000Z', model: 'model-b' }));
    const result = aggregateUsage(
      store,
      UsageQuerySchema.parse({ cursor: first.nextCursor, limit: 1 }),
    );
    expect(result.reset).toBe(true);
    expect(result.self.values.inputTokens).toBe(35);
    expect(aggregateUsage(store, query()).buckets.some((b) => b.day === '2026-01-02')).toBe(false);
  });
});

test('timezone, half-open intervals and unknown timestamps do not invent a day', () => {
  withStore((store) => {
    store.put(fact('edge', 10, { at: '2026-03-08T07:00:00.000Z' }));
    store.put(fact('unknown', 20, { at: null }));
    const local = aggregateUsage(
      store,
      UsageQuerySchema.parse({ timezone: 'America/Los_Angeles' }),
    );
    expect(local.buckets.find((b) => b.day !== null)?.day).toBe('2026-03-07');
    const interval = aggregateUsage(
      store,
      UsageQuerySchema.parse({ until: '2026-03-08T07:00:00.000Z' }),
    );
    expect(interval.self.values.inputTokens).toBeNull();
    expect(interval.unattributed.values.inputTokens).toBe(20);
    expect(interval.sourceEventRange).toEqual({
      first: '2026-03-08T07:00:00.000Z',
      last: '2026-03-08T07:00:00.000Z',
    });
  });
});

test('cumulative decrease is explicit partial evidence; native epoch change is a separate opening balance', () => {
  withStore((store) => {
    store.put(fact('one', 100, { mode: 'cumulative' }));
    store.put(fact('two', 50, { mode: 'cumulative' }));
    const result = aggregateUsage(store, query());
    expect(result.ambiguous).toBe(true);
    expect(result.self.coverage).toBe('partial');
  });
  withStore((store) => {
    store.put(fact('one', 100, { mode: 'cumulative' }));
    store.put(fact('two', 50, { mode: 'cumulative', epoch: 'new-native-epoch' }));
    expect(aggregateUsage(store, query()).self.values.inputTokens).toBe(150);
  });
});

test('checkpoint persists on append and facts/checkpoint roll back together', () => {
  const path = join(fixture(), 'history.jsonl');
  writeFileSync(path, `${Array.from({ length: 600 }, (_, i) => claude(`m${i}`, 1)).join('\n')}\n`);
  const counts: number[] = [];
  const scan = () => {
    let n = 0;
    indexTranscript(path, 'claude', (lines) => {
      n += lines.length;
      return { ...EMPTY_STATS, messages: lines.length };
    });
    counts.push(n);
  };
  scan();
  scan();
  appendFileSync(path, `${claude('m600', 1)}\n`);
  scan();
  scan();
  expect(counts).toEqual([600, 0, 1, 0]);
  withStore((store) => {
    expect(() =>
      store.transaction(() => {
        store.put(fact('bad', 10));
        store.write('checkpoint', 42);
        throw new Error('crash');
      }),
    ).toThrow('crash');
    expect([...store.facts()]).toHaveLength(0);
  });
});

test('same-size rewrite, malformed input, missing source and symlink keep distinct states', () => {
  const root = fixture(),
    path = join(root, 'history.jsonl');
  writeFileSync(path, `${claude('one', 10)}\n`);
  expect(readUsageFile('agent', path, 'claude', query(), true).self.values.inputTokens).toBe(10);
  writeFileSync(path, `${claude('two', 20)}\n`);
  expect(readUsageFile('agent', path, 'claude', query(), true).self.values.inputTokens).toBe(20);
  appendFileSync(path, 'not-json\n');
  expect(readUsageFile('agent', path, 'claude', query(), true).malformedRecords).toBe(1);
  chmodSync(path, 0o666);
  expect(readUsageFile('agent', path, 'claude', query()).source).toBe('unreadable');
  chmodSync(path, 0o600);
  const link = join(root, 'link');
  symlinkSync(path, link);
  expect(readUsageFile('agent', link, 'claude', query()).source).toBe('unreadable');
  rmSync(path);
  const stale = readUsageFile('agent', path, 'claude', query());
  expect(stale.source).toBe('missing');
  expect(stale.reason).toBe('source-missing');
  expect(stale.self.values.inputTokens).toBe(20);
});

test('provider metadata parsing never depends on conversation content', () => {
  const entry = JSON.parse(claude('one', 10));
  const parsed = parseUsageRecord(
    'claude',
    entry,
    { model: null, epoch: 'native' },
    '2026-01-01T00:00:00.000Z',
  );
  expect(parsed?.id).toBe('one');
  expect(JSON.stringify(parsed)).not.toContain('content');
  expect(JSON.stringify(parsed)).not.toContain('"text"');
});

test('warm aggregate and an appended correction never rescan the fact ledger', () => {
  withStore((store) => {
    store.put(fact('one', 10));
    expect(aggregateUsage(store, query()).self.values.inputTokens).toBe(10);
    store.contributionPage = () => {
      throw new Error('full ledger rescan');
    };
    store.put(fact('two', 20));
    expect(aggregateUsage(store, query()).self.values.inputTokens).toBe(30);
    store.put(fact('one', 12));
    expect(aggregateUsage(store, query()).self.values.inputTokens).toBe(32);
  });
});

test('correction of a cumulative event adjusts its successor without charging the change twice', () => {
  withStore((store) => {
    store.put(fact('one', 100, { mode: 'cumulative' }));
    store.put(fact('two', 150, { mode: 'cumulative' }));
    expect(aggregateUsage(store, query()).self.values.inputTokens).toBe(150);
    store.put(fact('one', 110, { mode: 'cumulative' }));
    expect(aggregateUsage(store, query()).self.values.inputTokens).toBe(150);
    expect(aggregateUsage(store, query()).unattributed.values.inputTokens).toBe(110);
  });
});
