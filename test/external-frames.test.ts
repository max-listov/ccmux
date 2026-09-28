import { expect, test } from 'bun:test';
import {
  applyExternalStatusFrame,
  createExternalStatusEncoder,
  type ExternalStatusFrame,
  ExternalStatusFrameSchema,
  type ExternalStatusSnapshot,
  ExternalStatusSnapshotSchema,
} from '../src/control-client.ts';

const GENERATION = '33333333-3333-4333-8333-333333333333';
const THREAD = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

function snapshot(sequence: number, state: 'idle' | 'working' = 'idle'): ExternalStatusSnapshot {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence * 2)).toISOString();
  const until = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence * 2 + 5)).toISOString();
  return ExternalStatusSnapshotSchema.parse({
    protocol: 1,
    version: '1.0.0',
    machine: 'host-a',
    generation: GENERATION,
    sequence,
    source: 'codex-app-server',
    status: 'live',
    reason: null,
    observedAt: at,
    expiresAt: until,
    truncated: false,
    omitted: 0,
    sessions: [1, 2, 3].map((n) => ({
      identity: { provider: 'codex', machine: 'host-a', threadId: THREAD(n) },
      name: `agent-${n}`,
      dir: `/work/agent-${n}`,
      updatedAt: '2026-01-01T00:00:00.000Z',
      turnState: {
        state: n === 2 ? state : 'idle',
        evidence: 'observed',
        source: 'codex-app-server',
        turnId: null,
        startedAt: null,
        observedAt: at,
        expiresAt: until,
        reason: 'native-status',
        remedy: null,
      },
    })),
  });
}

/** What a reader that folds every line holds after each one. */
function fold(frames: ExternalStatusFrame[]): (ExternalStatusSnapshot | null)[] {
  let held: ExternalStatusSnapshot | null = null;
  return frames.map((frame) => {
    held = applyExternalStatusFrame(held, ExternalStatusFrameSchema.parse(frame));
    return held;
  });
}

test('a quiet stream sends the snapshot once and then renewals the reader folds back exactly', () => {
  const encode = createExternalStatusEncoder();
  const published = [
    snapshot(1),
    snapshot(2),
    snapshot(3),
    snapshot(4, 'working'),
    snapshot(5, 'working'),
  ];
  const frames = published.map(encode);
  expect(frames.map((f) => f.frame)).toEqual([
    'snapshot',
    'renewal',
    'renewal',
    'snapshot',
    'renewal',
  ]);
  expect(fold(frames)).toEqual(published);
  const renewal = JSON.stringify(frames[1]);
  expect(Buffer.byteLength(renewal)).toBeLessThan(
    Buffer.byteLength(JSON.stringify(published[1])) / 4,
  );
});

test('a row observed at another moment than the snapshot travels in a snapshot, never guessed', () => {
  const encode = createExternalStatusEncoder();
  const first = snapshot(1);
  const second = snapshot(2);
  const row = second.sessions[0];
  if (row === undefined) throw new Error('fixture');
  row.turnState.observedAt = first.observedAt;
  row.turnState.expiresAt = first.expiresAt;
  expect([first, second].map(encode).map((f) => f.frame)).toEqual(['snapshot', 'snapshot']);
});

test('a renewal that does not follow what the reader holds is refused, so the reader reopens', () => {
  const encode = createExternalStatusEncoder();
  const frames = [snapshot(1), snapshot(2), snapshot(3)].map(encode);
  const [first, , third] = frames;
  if (first === undefined || third === undefined) throw new Error('fixture');
  // Missed the renewal to sequence 2: the one to 3 follows 2, not 1.
  expect(applyExternalStatusFrame(applyExternalStatusFrame(null, first), third)).toBeNull();
  expect(applyExternalStatusFrame(null, third)).toBeNull();
  const other = { ...snapshot(2), generation: '55555555-5555-4555-8555-555555555555' };
  expect(applyExternalStatusFrame(other, third)).toBeNull();
});
