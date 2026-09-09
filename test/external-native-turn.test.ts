import { expect, test } from 'bun:test';
import { ExternalSessionSchema } from '../src/config/schema.ts';
import {
  MAX_NATIVE_TURN_READS,
  readNativeTurns,
  withNativeTurn,
} from '../src/external/native-turn.ts';
import { ExternalTurnStateSchema, unknownTurnState } from '../src/external/turnSchema.ts';
import { nativeTurnState, observeExternalTurns } from '../src/external/turnState.ts';
import { makeMachine, UUID } from './helpers.ts';

const active = () => nativeTurnState({ type: 'active', activeFlags: [] }, Date.now());
const page = (startedAt: number | null = 1_000) => ({
  data: [
    {
      id: 'native-turn',
      status: 'inProgress',
      startedAt,
      itemsView: 'notLoaded',
      items: [],
    },
  ],
  nextCursor: 'must-not-follow',
});

test('metadata reads are bounded in concurrency and count, never request history or resume', async () => {
  let inFlight = 0,
    peak = 0,
    count = 0;
  const turns = await readNativeTurns(
    {
      userAgent: 'codex/0.151.0',
      close() {},
      request: async (method, params) => {
        expect(method).toBe('thread/turns/list');
        expect(params).toMatchObject({
          cursor: null,
          limit: 1,
          sortDirection: 'desc',
          itemsView: 'notLoaded',
        });
        peak = Math.max(peak, ++inFlight);
        count++;
        await Promise.resolve();
        inFlight--;
        return page();
      },
    },
    Array.from({ length: 100 }, (_, i) => String(i)),
    new AbortController().signal,
  );
  expect(count).toBe(MAX_NATIVE_TURN_READS);
  expect(peak).toBeLessThanOrEqual(4);
  expect(turns.size).toBe(MAX_NATIVE_TURN_READS);
});

test('missing, failed, malformed and non-metadata reads do not manufacture a turn', async () => {
  for (const result of [
    null,
    { data: [], nextCursor: null },
    { ...page(), data: [{ ...page().data[0], status: 'completed' }] },
    { ...page(), data: [{ ...page().data[0], itemsView: 'full', items: ['private'] }] },
    { ...page(), data: [{ ...page().data[0], startedAt: -1 }] },
    { ...page(), data: [...page().data, ...page().data] },
  ]) {
    const turns = await readNativeTurns(
      { userAgent: 'codex/0.151.0', close() {}, request: async () => result },
      [UUID],
      new AbortController().signal,
    );
    expect(withNativeTurn(active(), turns.get(UUID))).toMatchObject({
      state: 'working',
      turnId: null,
      startedAt: null,
    });
  }
  const turns = await readNativeTurns(
    {
      userAgent: 'codex/0.151.0',
      close() {},
      request: async () => {
        throw new Error('unreadable');
      },
    },
    [UUID],
    new AbortController().signal,
  );
  expect(turns.size).toBe(0);
  expect(
    withNativeTurn(active(), { id: 'native', status: 'inProgress', startedAt: null }),
  ).toMatchObject({ turnId: 'native', startedAt: null });
  expect(
    ExternalTurnStateSchema.safeParse({
      ...unknownTurnState('codex-app-server'),
      turnId: 'old',
      startedAt: '1970-01-01T00:16:40.000Z',
    }).success,
  ).toBe(false);
});

test('exact external discovery projection carries the same native fact as resident snapshots', async () => {
  const row = ExternalSessionSchema.parse({
    key: `external:codex:host-a#${UUID}`,
    plane: 'external',
    provider: 'codex',
    host: 'host-a',
    threadId: UUID,
    dir: null,
    path: null,
    origin: 'app-server',
    storage: 'missing',
    writerEvidence: 'none-observed',
    writerRuntime: null,
    turnState: unknownTurnState('codex-app-server'),
    capabilities: {
      inspect: false,
      attemptAdopt: false,
      fork: false,
      terminateAndAdopt: false,
      releaseAtSource: false,
      reasons: [],
    },
    lastActivityMs: null,
    lastModel: null,
    usedTokens: null,
    lastMessage: null,
  });
  const result = await observeExternalTurns(makeMachine(), [row], async () => ({
    userAgent: 'codex/0.151.0',
    close() {},
    request: async (method) =>
      method === 'thread/list'
        ? { data: [{ id: UUID, status: { type: 'active', activeFlags: [] } }], nextCursor: null }
        : page(),
  }));
  expect(result[0]?.turnState).toMatchObject({
    turnId: 'native-turn',
    startedAt: '1970-01-01T00:16:40.000Z',
  });
});
