import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptIndexPath } from '../src/agent/transcriptIndex.ts';
import { readUsageFile } from '../src/usage/file.ts';
import { USAGE_SLICE_BYTES, UsageQuerySchema } from '../src/usage/schema.ts';

/** Synthetic, local-only probe. No provider credentials, native storage or running daemon. */
const root = mkdtempSync(join(tmpdir(), 'ccmux-usage-measure-'));
const path = join(root, 'history.jsonl');
const q = UsageQuerySchema.parse({});
const count = 50_000;
const line = (id: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: {
      id: `message-${id}`,
      role: 'assistant',
      model: 'model-a',
      content: [{ type: 'text', text: 'x'.repeat(2000) }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 2,
      },
    },
  });
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}
try {
  const fd = openSync(path, 'w', 0o600);
  try {
    for (let i = 0; i < count; i++) writeSync(fd, `${line(i)}\n`);
  } finally {
    closeSync(fd);
  }
  Bun.gc(true);
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const slices: number[] = [];
  let indexed = 0;
  let maxDelta = 0;
  let result = readUsageFile('host-a:agent-a', path, 'claude', q);
  if (result.state !== 'building' || result.indexedBytes !== 0)
    throw new Error('Cold probe did not start cold');
  const started = performance.now();
  while (result.state === 'building') {
    const start = performance.now();
    result = readUsageFile('host-a:agent-a', path, 'claude', q, true);
    slices.push(performance.now() - start);
    maxDelta = Math.max(maxDelta, result.indexedBytes - indexed);
    indexed = result.indexedBytes;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  const backfillMs = performance.now() - started;
  if (
    result.state !== 'ready' ||
    result.self.values.inputTokens !== count * 10 ||
    maxDelta > USAGE_SLICE_BYTES
  )
    throw new Error('Backfill result is not the fixture total');
  const warm: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    result = readUsageFile('host-a:agent-a', path, 'claude', q);
    warm.push(performance.now() - start);
  }
  appendFileSync(path, `${line(count)}\n`);
  const appendStart = performance.now();
  const appended = readUsageFile('host-a:agent-a', path, 'claude', q, true);
  const appendMs = performance.now() - appendStart;
  if (appended.self.values.inputTokens !== (count + 1) * 10)
    throw new Error('Append did not change the measured total once');
  console.log(
    JSON.stringify(
      {
        records: count,
        sourceBytes: indexed,
        maxIndexedBytesPerSlice: maxDelta,
        backfillMs,
        slices: distribution(slices),
        warm: distribution(warm),
        appendMs,
        appendBytes: appended.indexedBytes - indexed,
        replyBytes: Buffer.byteLength(JSON.stringify(appended)),
        databaseBytes: statSync(transcriptIndexPath(path)).size,
        baselineRssBytes: baselineRss,
        peakSampledRssBytes: peakRss,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(transcriptIndexPath(path), { force: true });
}
