import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createApplication, type ManagedScheduleClock } from 'stitchkit/application';
import { encodeDir } from '../src/agent/claude/resume.ts';
import { ExternalStatusPublisher } from '../src/external/residentPublisher.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { readUsageFile } from '../src/usage/file.ts';
import { createUsageObservation } from '../src/usage/observation.ts';
import { pendingUsageIndexes } from '../src/usage/queue.ts';
import { UsageQuerySchema } from '../src/usage/schema.ts';
import { readSessionUsage } from '../src/usage/service.ts';
import { makeMachine, makeSession } from './helpers.ts';

const query = UsageQuerySchema.parse({
  since: '2026-01-01T00:00:00Z',
  until: '2026-01-01T03:00:00Z',
});
const record = (id: string, tokens = 1, timestamp = '2026-01-01T01:00:00Z') =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      id,
      role: 'assistant',
      content: [],
      usage: { input_tokens: tokens, output_tokens: 2 },
    },
  })}\n`;

test('a single cold window read finishes in background over a 200 MiB source without consumer polling', async () => {
  const root = mkdtempSync('/tmp/ccmux-window-');
  const m = makeMachine({
    stateDir: root,
    projectsDir: join(root, 'projects'),
    rcPrefix: 'host-a',
  });
  const s = makeSession({ name: 'worker', dir: root });
  await writeSessionsUnlocked(m, [s]);
  const dir = join(m.projectsDir, encodeDir(root));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${s.uuid}.jsonl`);
  writeFileSync(path, '');
  const padding = `${JSON.stringify({ type: 'progress', data: 'x'.repeat(1024 * 1024) })}\n`;
  for (let i = 0; i < 200; i++) appendFileSync(path, padding);
  for (let i = 0; i < 1501; i++) appendFileSync(path, record(String(i)));
  let now = 0;
  const timers: { callback: () => void; at: number }[] = [];
  const clock: ManagedScheduleClock = {
    now: () => now,
    wallNow: () => new Date(now),
    schedule(callback, delay) {
      const timer = { callback, at: now + delay };
      timers.push(timer);
      return {
        cancel() {
          const i = timers.indexOf(timer);
          if (i >= 0) timers.splice(i, 1);
        },
      };
    },
  };
  const external = new ExternalStatusPublisher('host-a');
  const observer = createUsageObservation(() => m, external, clock);
  const app = createApplication({ id: 'window-test', resources: [observer] });
  try {
    const start = performance.now();
    const cold = await readSessionUsage(m, 'host-a:worker', query);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(cold.state).toBe('building');
    expect(cold.retryAfterMs).toBeGreaterThan(0);
    await app.start();
    let ticks = 0;
    while (pendingUsageIndexes(m.stateDir).length && ticks++ < 80) {
      const timer = timers.shift();
      if (!timer) throw new Error('missing timer');
      now = timer.at;
      timer.callback();
      await setImmediate();
    }
    expect(ticks).toBeLessThan(80);
    expect(pendingUsageIndexes(m.stateDir)).toHaveLength(0);
    const ready = await readSessionUsage(m, 'host-a:worker', query);
    expect(ready.state).toBe('ready');
    expect(ready.self.values.inputTokens).toBe(1501);
    expect(ready.retryAfterMs).toBeNull();
  } finally {
    await app.shutdown();
    external.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('past windows cover a fixed source snapshot including out-of-order events and later corrections', () => {
  const root = mkdtempSync('/tmp/ccmux-window-tail-'),
    path = join(root, 'history.jsonl');
  const padding = `${JSON.stringify({ type: 'progress', data: 'x'.repeat(1024 * 1024) })}\n`;
  try {
    writeFileSync(
      path,
      record('after', 99, '2026-01-02T00:00:00Z') + padding.repeat(10) + record('inside', 7),
    );
    const first = readUsageFile('worker', path, 'claude', query, true);
    expect(first.state).toBe('building');
    const fence = first.sourceCoverage?.targetBytes;
    for (let i = 0; i < 3; i++) {
      appendFileSync(path, padding.repeat(5));
      readUsageFile('worker', path, 'claude', query, true);
    }
    const ready = readUsageFile('worker', path, 'claude', query);
    expect(ready.state).toBe('ready');
    expect(ready.sourceCoverage?.targetBytes).toBe(fence);
    expect(ready.indexedBytes).toBeLessThan(ready.sourceBytes ?? 0);
    expect(ready.self.values.inputTokens).toBe(7);
    appendFileSync(path, record('inside', 11));
    for (let i = 0; i < 10; i++) readUsageFile('worker', path, 'claude', query, true);
    expect(readUsageFile('worker', path, 'claude', query).self.values.inputTokens).toBe(11);
    const empty = readUsageFile(
      'worker',
      path,
      'claude',
      UsageQuerySchema.parse({ since: '2025-01-01T00:00:00Z', until: '2025-01-02T00:00:00Z' }),
    );
    expect(empty.state).toBe('ready');
    expect(empty.reason).toBe('no-usage-observations');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
