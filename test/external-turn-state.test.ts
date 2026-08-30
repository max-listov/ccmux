import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { type CodexAppRpc, connectCodexAppServer } from '../src/agent/codex/appServer.ts';
import { ExternalSessionSchema } from '../src/config/schema.ts';
import { ExternalTurnStateSchema, unknownTurnState } from '../src/external/turnSchema.ts';
import {
  nativeTurnState,
  observeExternalTurns,
  TURN_OBSERVATION_TTL_MS,
} from '../src/external/turnState.ts';
import { makeMachine, UUID } from './helpers.ts';

const OTHER = '22222222-2222-4222-8222-222222222222';
const machine = makeMachine();
const row = (id = UUID) =>
  ExternalSessionSchema.parse({
    key: `external:codex:host-a#${id}`,
    plane: 'external',
    provider: 'codex',
    host: 'host-a',
    threadId: id,
    dir: null,
    path: null,
    origin: 'app-server',
    storage: 'missing',
    writerEvidence: 'observed',
    writerRuntime: {
      kind: 'shared',
      pid: 42,
      startTime: 'runtime-generation',
      processGroup: 42,
      reason: 'shared runtime',
    },
    turnState: unknownTurnState('codex-app-server'),
    capabilities: {
      inspect: false,
      attemptAdopt: false,
      fork: false,
      terminateAndAdopt: false,
      releaseAtSource: true,
      reasons: ['shared'],
    },
    lastActivityMs: null,
    lastModel: null,
    usedTokens: null,
    lastMessage: null,
  });
const active = { type: 'active', activeFlags: [] };
const rpc = (handler: (method: string, params: unknown) => unknown): CodexAppRpc => ({
  userAgent: 'Codex Desktop/0.149.0 (test)',
  request: async (method, params) => handler(method, params),
  close() {},
});

describe('independent native external turn evidence', () => {
  test('shared writer remains observed while one thread completes and the other works', async () => {
    const sessions = [row(), row(OTHER)];
    const client = rpc((method, params) => {
      expect(method).toBe('thread/list');
      expect(params).toMatchObject({ useStateDbOnly: true, limit: 128 });
      return {
        data: [
          { id: UUID, status: active },
          { id: OTHER, status: { type: 'idle' } },
        ],
        nextCursor: null,
      };
    });
    const result = await observeExternalTurns(machine, sessions, async () => client);
    expect(result.map((s) => s.turnState.state)).toEqual(['working', 'idle']);
    expect(result.map((s) => s.writerEvidence)).toEqual(['observed', 'observed']);
    expect(result.map((s) => s.writerRuntime)).toEqual(sessions.map((s) => s.writerRuntime));
    expect(result.map((s) => s.capabilities)).toEqual(sessions.map((s) => s.capabilities));
  });

  test('native start, completion, interruption and waiting flags have independent states', () => {
    const statuses = [
      active,
      { type: 'idle' },
      active,
      { type: 'idle' },
      { type: 'active', activeFlags: ['waitingOnApproval'] },
      { type: 'active', activeFlags: ['waitingOnUserInput'] },
      { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] },
    ];
    expect(statuses.map((s) => nativeTurnState(s, 1000).state)).toEqual([
      'working',
      'idle',
      'working',
      'idle',
      'waiting-approval',
      'waiting-input',
      'waiting-approval',
    ]);
    for (const s of statuses) {
      const observed = ExternalTurnStateSchema.parse(nativeTurnState(s, 1000));
      expect(observed.source).toBe('codex-app-server');
      expect(Date.parse(observed.expiresAt ?? '') - Date.parse(observed.observedAt ?? '')).toBe(
        TURN_OBSERVATION_TTL_MS,
      );
    }
  });

  test('loaded identity, malformed or future status never means working or idle', () => {
    for (const status of [
      { type: 'notLoaded' },
      { type: 'systemError' },
      {},
      { type: 'active' },
      { type: 'active', activeFlags: ['new-provider-flag'] },
    ]) {
      expect(nativeTurnState(status, 1000)).toMatchObject({
        state: 'unknown',
        evidence: 'unknown',
      });
    }
    expect(
      ExternalTurnStateSchema.safeParse({
        ...unknownTurnState('codex-app-server'),
        state: 'working',
      }).success,
    ).toBe(false);
  });

  test('disconnect clears working, reconnect reports current idle, missing clears idle', async () => {
    let rows = [{ ...row(), turnState: nativeTurnState(active, Date.now()) }];
    rows = await observeExternalTurns(machine, rows, async () => {
      throw new Error('offline');
    });
    expect(rows[0]?.turnState).toMatchObject({ state: 'unknown', evidence: 'unavailable' });
    rows = await observeExternalTurns(machine, rows, async () =>
      rpc(() => ({ data: [{ id: UUID, status: { type: 'idle' } }], nextCursor: null })),
    );
    expect(rows[0]?.turnState.state).toBe('idle');
    rows = await observeExternalTurns(machine, rows, async () =>
      rpc(() => ({ data: [], nextCursor: null })),
    );
    expect(rows[0]?.turnState).toMatchObject({ state: 'unknown', reason: 'not-reported' });
  });

  test('100 reads use one bounded native request each, no transcript or mutation requests', async () => {
    let requests = 0;
    let closed = 0;
    for (let i = 0; i < 100; i++)
      await observeExternalTurns(machine, [row()], async () => ({
        userAgent: 'Codex Desktop/0.149.0 (test)',
        request: async (method, params) => {
          expect(method).toBe('thread/list');
          expect(params).toMatchObject({ useStateDbOnly: true });
          requests++;
          return { data: [{ id: UUID, status: active }], nextCursor: null };
        },
        close: () => {
          closed++;
        },
      }));
    expect(requests).toBe(100);
    expect(closed).toBe(100);
  });

  test('pagination is capped and malformed pages fail closed, including earlier working', async () => {
    let count = 0;
    const result = await observeExternalTurns(machine, [row()], async () =>
      rpc(() => ({ data: [], nextCursor: String(++count) })),
    );
    expect(count).toBe(4);
    expect(result[0]?.turnState.reason).toBe('read-limit');
    count = 0;
    const broken = await observeExternalTurns(machine, [row(), row(OTHER)], async () =>
      rpc(() =>
        ++count === 1
          ? { data: [{ id: UUID, status: active }], nextCursor: 'next' }
          : { data: 'invalid' },
      ),
    );
    expect(broken.every((s) => s.turnState.state === 'unknown')).toBe(true);
  });

  test('unsupported providers never connect', async () => {
    const unsupported = ExternalSessionSchema.parse({
      ...row(),
      provider: 'claude',
      turnState: unknownTurnState('unsupported', 'unsupported-provider'),
    });
    const result = await observeExternalTurns(machine, [unsupported], async () => {
      throw new Error('must not connect');
    });
    expect(result[0]?.turnState.source).toBe('unsupported');
  });

  test('unknown or older runtime never receives a potentially scanning list request', async () => {
    for (const userAgent of [
      undefined,
      'custom',
      'Codex Desktop/0.140.0 (test)',
      'Codex Desktop/0.140.0-alpha.8 (test)',
      'Codex Desktop/0.144.6-alpha.8 (test)',
      'Codex Desktop/0.150.0invalid (test)',
      'Codex Desktop/0.150.0-.. (test)',
    ]) {
      const result = await observeExternalTurns(machine, [row()], async () => ({
        userAgent,
        request: async () => {
          throw new Error('must not request');
        },
        close() {},
      }));
      expect(result[0]?.turnState.reason).toBe('unsupported-runtime');
    }
  });

  test('newer prereleases and floor build metadata retain bounded native observation', async () => {
    for (const userAgent of [
      'Codex Desktop/0.150.0-alpha.8 (test)',
      'Codex Desktop/0.144.6+build.1 (test)',
      'codex/0.150.0-alpha.8+build.1',
    ]) {
      let requests = 0;
      const result = await observeExternalTurns(machine, [row()], async () => ({
        userAgent,
        request: async (method, params) => {
          requests++;
          expect(method).toBe('thread/list');
          expect(params).toMatchObject({ useStateDbOnly: true });
          return { data: [{ id: UUID, status: active }], nextCursor: null };
        },
        close() {},
      }));
      expect(requests).toBe(1);
      expect(result[0]?.turnState.state).toBe('working');
    }
  });
});

describe('bounded real control-socket transport', () => {
  async function fixture(mode: 'status' | 'hang' | 'oversize') {
    const root = mkdtempSync(join(tmpdir(), 'ccmux-turn-socket-'));
    const dir = join(root, 'app-server-control');
    mkdirSync(dir);
    const requests: string[] = [];
    const server = Bun.serve({
      unix: join(dir, 'app-server-control.sock'),
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const message = z
            .object({ id: z.number().optional(), method: z.string() })
            .parse(JSON.parse(String(raw)));
          requests.push(message.method);
          if (message.method === 'initialize')
            ws.send(
              JSON.stringify({
                id: message.id,
                result: { userAgent: 'Codex Desktop/0.149.0 (test)' },
              }),
            );
          if (message.method !== 'thread/list') return;
          if (mode === 'status')
            ws.send(
              JSON.stringify({
                id: message.id,
                result: { data: [{ id: UUID, status: active }], nextCursor: null },
              }),
            );
          if (mode === 'oversize') ws.send('x'.repeat(3 * 1024 * 1024));
        },
      },
    });
    return {
      machine: makeMachine({ codexHome: root }),
      requests,
      close: () => {
        server.stop(true);
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  test('real WebSocket read returns state without thread/read, resume, or turn/start', async () => {
    const f = await fixture('status');
    try {
      const result = await observeExternalTurns(f.machine, [row()]);
      expect(result[0]?.turnState.state).toBe('working');
      expect(f.requests).toEqual(['initialize', 'initialized', 'thread/list']);
    } finally {
      f.close();
    }
  });

  test('deadline closes stalled socket and never keeps previous working', async () => {
    const f = await fixture('hang');
    try {
      const start = performance.now();
      const result = await observeExternalTurns(f.machine, [
        { ...row(), turnState: nativeTurnState(active, Date.now() - 10_000) },
      ]);
      expect(result[0]?.turnState).toMatchObject({
        state: 'unknown',
        evidence: 'stale',
        reason: 'deadline',
      });
      expect(performance.now() - start).toBeLessThan(3000);
    } finally {
      f.close();
    }
  });

  test('oversize response fails closed and an already-aborted connect opens nothing', async () => {
    const f = await fixture('oversize');
    try {
      expect((await observeExternalTurns(f.machine, [row()]))[0]?.turnState.evidence).toBe(
        'unavailable',
      );
      const controller = new AbortController();
      controller.abort();
      await expect(
        connectCodexAppServer(f.machine, { signal: controller.signal }),
      ).rejects.toThrow();
    } finally {
      f.close();
    }
  });
});
