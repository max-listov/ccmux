import { expect, test } from 'bun:test';
import { composeSnapshot, type SnapshotInput } from '../src/agent/claude/native/snapshot.ts';
import { initialTurn } from '../src/agent/claude/native/turn.ts';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-09-01T10:00:00.000Z');

const input = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  identity: {
    machine: 'host-a',
    session: 'agent-a',
    threadId: UUID_A,
    generation: UUID_B,
    pid: 100,
    providerPid: 101,
    version: '2.1.252',
  },
  sequence: 1,
  connected: true,
  permissionMode: 'default',
  contextUsage: undefined,
  planLimits: undefined,
  account: undefined,
  spend: undefined,
  fileCheckpoints: false,
  mcpServers: undefined,
  turn: initialTurn,
  turnId: null,
  turnStartedAt: null,
  items: [],
  pending: [],
  selection: null,
  now: NOW,
  ...over,
});

test('a disconnected runtime reports that it knows nothing, not its last guess', () => {
  // The previous observation stays on disk. Republishing the last state it saw would keep asserting
  // a fact whose source has gone away — a session frozen mid-turn would read as working forever.
  const snapshot = composeSnapshot(
    input({ connected: false, turn: { ...initialTurn, state: 'working' } }),
  );
  expect(snapshot.state).toBe('unknown');
  expect(snapshot.reason).toBe('runtime-disconnected');
});

test('the lease is stamped from the observation instant, not from whenever the write lands', () => {
  const snapshot = composeSnapshot(input());
  expect(snapshot.observedAt).toBe('2026-09-01T10:00:00.000Z');
  expect(Date.parse(snapshot.expiresAt) - Date.parse(snapshot.observedAt)).toBe(5000);
});

test('a turn is published only once it has a status and an id', () => {
  // Half a turn is worse than none: a reader correlating an answer to a turn needs both, and an id
  // with no status invites treating an unstarted turn as running.
  expect(composeSnapshot(input()).turn).toBeNull();
  expect(composeSnapshot(input({ turnId: 'turn-1' })).turn).toBeNull();
  const running = composeSnapshot(
    input({ turnId: 'turn-1', turn: { ...initialTurn, status: 'inProgress', state: 'working' } }),
  );
  expect(running.turn).toEqual({ id: 'turn-1', status: 'inProgress', startedAt: null });
});

test('unrecognised runtime messages are surfaced in the reason', () => {
  // A build older than the runtime it drives would otherwise present a partial conversation as a
  // complete one, with nothing anywhere saying a part is missing.
  const snapshot = composeSnapshot(
    input({ turn: { ...initialTurn, unhandled: ['brand_new', 'compact_boundary'] } }),
  );
  expect(snapshot.reason).toContain('brand_new');
  expect(snapshot.reason).toContain('compact_boundary');
});

test('a healthy connected runtime gives no reason, because the state says it', () => {
  expect(composeSnapshot(input()).reason).toBeNull();
});

test('the bounded window keeps the RECENT end', () => {
  // Dropping the newest would answer "what is happening now" with what happened first — the bound
  // is there to limit size, not to freeze the session at its beginning.
  const items = Array.from({ length: 200 }, (_, i) => ({
    sequence: i + 1,
    at: '2026-09-01T10:00:00.000Z',
    kind: 'assistant' as const,
    stage: 'completed' as const,
    nativeId: `item-${i}`,
    turnId: 'turn-1',
    requestId: null,
    status: null,
    text: `${i}`,
    tool: null,
    usage: null,
  }));
  const snapshot = composeSnapshot(input({ items }));
  expect(snapshot.nativeItems).toHaveLength(128);
  expect(snapshot.nativeItems.at(-1)).toMatchObject({ nativeId: 'item-199' });
  // The count reported is what actually happened, not what survived the window.
  expect(snapshot.nativeSequence).toBe(200);
});

test('the snapshot is validated on the way out, so a malformed one never reaches a reader', () => {
  // Every reader that cannot see the session believes this file. Composing an invalid one and
  // discovering it at the reader would put the failure furthest from its cause.
  expect(() =>
    composeSnapshot(input({ identity: { ...input().identity, threadId: 'not-a-uuid' } })),
  ).toThrow();
});
