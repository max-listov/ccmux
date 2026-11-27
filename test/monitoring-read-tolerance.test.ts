import { expect, test } from 'bun:test';
import { MonitoringSnapshotReadSchema } from '../src/monitoring/schema.ts';
import { validateSnapshot } from '../src/monitoring/validate.ts';

const row = (patch: Record<string, unknown> = {}) => ({
  plane: 'managed',
  name: 'agent-a',
  agent: 'claude',
  uuid: '11111111-1111-4111-8111-111111111111',
  rc: 'host-a-agent-a',
  address: 'host-a:agent-a',
  dir: '/tmp',
  archived: false,
  running: true,
  state: 'idle',
  model: null,
  contextPercent: null,
  statusLineRendersPerMinute: null,
  uptimeSeconds: null,
  lastActivityAt: null,
  turnStartedAt: null,
  observedAt: new Date().toISOString(),
  ...patch,
});

const snapshot = (sessions: unknown[]) => ({
  protocol: 1,
  version: '9.9.9',
  generation: '22222222-2222-4222-8222-222222222222',
  sequence: 1,
  pid: process.pid,
  rcPrefix: 'host-a',
  scope: 'managed',
  observedAt: new Date().toISOString(),
  generatedAt: new Date().toISOString(),
  refreshDurationMs: 1,
  maxAgeMs: 10_000,
  limits: { items: 256, bytes: 512 * 1024 },
  omitted: 0,
  sessions,
});

test('a snapshot from a newer daemon reads: unknown state and agent become unknown, unknown fields drop', () => {
  const read = validateSnapshot(
    JSON.stringify(
      snapshot([
        row({
          name: 'agent-new',
          state: 'hibernating',
          agent: 'gemini-cli',
          futureField: { x: 1 },
        }),
        row({ name: 'agent-old' }),
      ]),
    ),
    'host-a',
  );
  expect(read.status).toBe('live');
  const [future, known] = read.snapshot?.sessions ?? [];
  expect(future).toMatchObject({ name: 'agent-new', state: 'unknown', agent: 'unknown' });
  expect(future !== undefined && 'futureField' in future).toBe(false);
  expect(known).toMatchObject({ name: 'agent-old', state: 'idle', agent: 'claude' });
});

test('a row that breaks a required field or bound is still refused, not read as unknown', () => {
  for (const broken of [
    row({ uuid: 'not-a-uuid' }),
    row({ contextPercent: 140 }),
    row({ name: undefined }),
  ])
    expect(MonitoringSnapshotReadSchema.safeParse(snapshot([broken])).success).toBe(false);
  expect(validateSnapshot(JSON.stringify(snapshot([row({ uuid: 'x' })])), 'host-a')).toMatchObject({
    status: 'unavailable',
    reason: 'invalid',
  });
});
