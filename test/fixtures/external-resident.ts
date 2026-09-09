import { afterEach, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createControlClient } from '../../src/control/client.ts';
import { controlSocket } from '../../src/control/path.ts';
import { ControlPublisher } from '../../src/control/publisher.ts';
import { createControlServer } from '../../src/control/server.ts';
import type { NativeTurn } from '../../src/external/native-turn.ts';
import { ExternalStatusObserver } from '../../src/external/resident-observer.ts';
import { ExternalStatusPublisher } from '../../src/external/resident-publisher.ts';
import { makeMachine, UUID } from '../helpers.ts';

const OTHER = '22222222-2222-4222-8222-222222222222';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const RequestSchema = z.object({
  method: z.string(),
  id: z.number().optional(),
  params: z.unknown().optional(),
});
export const row = (id = UUID, type = 'active') => ({
  id,
  name: 'Native title',
  cwd: '/project',
  updatedAt: 1_787_900_000,
  status: { type, activeFlags: [] },
  preview: 'private body never exported',
  turns: [{ secret: true }],
});

export async function fixture() {
  const root = mkdtempSync('/tmp/ccmux-external-resident-');
  const dir = join(root, 'app-server-control');
  mkdirSync(dir);
  const machine = makeMachine({ stateDir: root, codexHome: root, rcPrefix: 'host-a' });
  const state = {
    rows: [row(), row(OTHER, 'idle')],
    connections: 0,
    requests: 0,
    methods: new Set<string>(),
    hang: false,
    broken: false,
    cursor: false,
    race: false,
    version: 'codex/0.150.0-alpha.12.2',
    turn: { id: 'turn-one', status: 'inProgress', startedAt: 1_787_900_000 } satisfies NativeTurn,
    turnRequests: 0,
    turnRace: false,
  };
  const provider = Bun.serve({
    unix: join(dir, 'app-server-control.sock'),
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        state.connections++;
        ws.subscribe('native-status');
      },
      message(ws, bytes) {
        const request = RequestSchema.parse(JSON.parse(String(bytes)));
        state.methods.add(request.method);
        if (request.method === 'initialize')
          ws.send(JSON.stringify({ id: request.id, result: { userAgent: state.version } }));
        if (request.method === 'thread/turns/list') {
          state.turnRequests++;
          expect(request.params).toEqual({
            threadId: UUID,
            cursor: null,
            limit: 1,
            sortDirection: 'desc',
            itemsView: 'notLoaded',
          });
          if (state.turnRace)
            ws.send(
              JSON.stringify({
                method: 'turn/started',
                params: {
                  threadId: UUID,
                  turn: { id: 'turn-race', status: 'inProgress', startedAt: 1_787_900_900 },
                },
              }),
            );
          ws.send(
            JSON.stringify({
              id: request.id,
              result: {
                data: [{ ...state.turn, items: [], itemsView: 'notLoaded' }],
                nextCursor: 'older-history-not-read',
              },
            }),
          );
          return;
        }
        if (request.method !== 'thread/list') return;
        state.requests++;
        expect(request.params).toMatchObject({ useStateDbOnly: true, limit: 128 });
        if (state.hang) return;
        if (state.race)
          ws.send(
            JSON.stringify({
              method: 'thread/status/changed',
              params: {
                threadId: UUID,
                status: { type: 'active', activeFlags: ['waitingOnApproval'] },
              },
            }),
          );
        ws.send(
          JSON.stringify({
            id: request.id,
            result: {
              data: state.broken ? 'broken' : state.rows,
              nextCursor: state.cursor ? 'repeated' : null,
            },
          }),
        );
      },
    },
  });
  const external = new ExternalStatusPublisher(machine.rcPrefix),
    observer = new ExternalStatusObserver(machine, external);
  const managed = new ControlPublisher(machine);
  const owned = createControlServer(machine, managed, undefined, () => machine, external);
  const client = createControlClient({ socket: controlSocket(machine) });
  cleanup.push(async () => {
    await client.close();
    await observer.close();
    managed.close();
    await owned.server.shutdown({ gracePeriodMs: 100, forceTimeoutMs: 100 });
    await owned.observability.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  });
  return { machine, state, external, observer, client, provider };
}
