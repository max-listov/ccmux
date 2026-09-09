import { expect, test } from 'bun:test';
import type { NativeTurn } from '../src/external/native-turn.ts';
import {
  currentExternalStatus,
  ExternalStatusSnapshotSchema,
} from '../src/external/resident-schema.ts';
import { fixture } from './fixtures/external-resident.ts';
import { UUID } from './helpers.ts';

test('native turn start survives reconciliation and reconnect, independent of observation freshness', async () => {
  const f = await fixture();
  f.state.version = 'codex/0.151.0';
  await f.observer.refresh();
  const first = await f.client['external.list']();
  const expected = { turnId: 'turn-one', startedAt: '2026-08-28T06:53:20.000Z' };
  expect(first.sessions[0]?.turnState).toMatchObject(expected);
  expect(first.sessions[0]?.turnState.observedAt).not.toBe(expected.startedAt);
  await f.observer.refresh();
  expect((await f.client['external.list']()).sessions[0]?.turnState).toMatchObject(expected);
  expect(f.state.turnRequests).toBe(2);
  f.state.broken = true;
  await f.observer.refresh();
  expect(f.external.read().sessions[0]?.turnState).toMatchObject({
    state: 'unknown',
    turnId: null,
    startedAt: null,
  });
  f.state.broken = false;
  await f.observer.refresh();
  const reconnected = await f.client['external.list']();
  expect(reconnected.generation).not.toBe(first.generation);
  expect(reconnected.sessions[0]?.turnState).toMatchObject(expected);
  const expired = currentExternalStatus(reconnected, Date.parse(reconnected.expiresAt ?? '') + 1);
  expect(expired.sessions[0]?.turnState).toMatchObject({
    state: 'unknown',
    turnId: null,
    startedAt: null,
  });
  f.state.turn.id = 'turn-two';
  f.state.turn.startedAt += 100;
  await f.observer.refresh();
  expect(f.external.read().sessions[0]?.turnState).toMatchObject({
    turnId: 'turn-two',
    startedAt: '2026-08-28T06:55:00.000Z',
  });
});

test('native turn notifications beat an older read and never use event receipt time as start', async () => {
  const f = await fixture();
  f.state.version = 'codex/0.151.0';
  f.state.turnRace = true;
  await f.observer.refresh();
  expect(f.external.read().sessions[0]?.turnState).toMatchObject({
    turnId: 'turn-race',
    startedAt: '2026-08-28T07:08:20.000Z',
  });
  const abort = new AbortController();
  const stream = await f.client.watchExternal.withOptions({ signal: abort.signal });
  await stream.next();
  const send = async (method: string, turn: NativeTurn) => {
    const next = stream.next();
    f.provider.publish(
      'native-status',
      JSON.stringify({ method, params: { threadId: UUID, turn } }),
    );
    return ExternalStatusSnapshotSchema.parse((await next).value).sessions[0]?.turnState;
  };
  expect(await send('turn/started', { id: 'no-time', status: 'inProgress' })).toMatchObject({
    turnId: 'no-time',
    startedAt: null,
  });
  expect(await send('turn/completed', { id: 'no-time', status: 'completed' })).toMatchObject({
    state: 'idle',
    turnId: null,
    startedAt: null,
  });
  expect(
    await send('turn/started', { id: 'new-turn', status: 'inProgress', startedAt: 1_787_900_100 }),
  ).toMatchObject({ state: 'working', turnId: 'new-turn', startedAt: '2026-08-28T06:55:00.000Z' });
  const next = stream.next();
  f.provider.publish(
    'native-status',
    JSON.stringify({
      method: 'thread/status/changed',
      params: {
        threadId: UUID,
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      },
    }),
  );
  expect(
    ExternalStatusSnapshotSchema.parse((await next).value).sessions[0]?.turnState,
  ).toMatchObject({
    state: 'waiting-approval',
    turnId: 'new-turn',
    startedAt: '2026-08-28T06:55:00.000Z',
  });
  abort.abort();
  await stream.return?.();
});
