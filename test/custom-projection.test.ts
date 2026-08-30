import { expect, test } from 'bun:test';
import type { AgentRuntimeEvent } from 'stitchkit/agent-runtime';
import { CustomProjection } from '../src/agent/custom/projection.ts';
import { ContentBuffer } from '../src/content/buffer.ts';
import {
  CONTENT_BASELINE_BYTES,
  CONTENT_MAX_RECORDS,
  CONTENT_REPLAY_BYTES,
} from '../src/content/schema.ts';
import { customFixture } from './custom-fixture.ts';

test('Custom native gaps invalidate content until canonical resync; replay and text stay bounded', async () => {
  const { m, s } = await customFixture();
  const content = new ContentBuffer(m, s, crypto.randomUUID());
  const projection = new CustomProjection(m, s, content, crypto.randomUUID());
  const delta = (sequence: number, epoch = 'first'): AgentRuntimeEvent => ({
    type: 'assistant-delta',
    conversationId: s.nativeSession?.id ?? '',
    runId: 'run',
    runtimeEpoch: epoch,
    sequence,
    emittedAt: new Date().toISOString(),
    textDelta: 'x'.repeat(1024),
  });
  projection.run('run', 'inProgress', new Date().toISOString());
  projection.event(delta(1));
  const sequence = content.snapshot().sequence;
  projection.event(delta(1));
  expect(content.snapshot().sequence).toBe(sequence);
  projection.event(delta(3));
  expect(projection.snapshot()).toMatchObject({
    state: 'unknown',
    connected: false,
    reason: 'native-resync-required',
  });
  expect(content.snapshot().baseline).toHaveLength(0);
  projection.run('run', 'inProgress', new Date().toISOString());
  for (let n = 4; n < 2000; n++) projection.event(delta(n));
  const snapshot = content.snapshot();
  expect(snapshot.records.length).toBeLessThanOrEqual(CONTENT_MAX_RECORDS);
  expect(Buffer.byteLength(JSON.stringify(snapshot.records))).toBeLessThanOrEqual(
    CONTENT_REPLAY_BYTES + 2,
  );
  expect(Buffer.byteLength(JSON.stringify(snapshot.baseline))).toBeLessThanOrEqual(
    CONTENT_BASELINE_BYTES + 2,
  );
  projection.event(delta(1, 'restarted'));
  expect(projection.snapshot().connected).toBe(false);
  projection.run('run', 'completed', new Date().toISOString());
  projection.requests([]);
  expect(projection.snapshot().state).toBe('idle');
  expect(
    content.snapshot().baseline.some((item) => item.kind === 'terminal' && item.turnId === 'run'),
  ).toBe(true);
});
