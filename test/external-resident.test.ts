import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlServer } from '../src/control/server.ts';
import { ExternalStatusObserver } from '../src/external/resident-observer.ts';
import { ExternalStatusPublisher } from '../src/external/resident-publisher.ts';
import {
  currentExternalStatus,
  EXTERNAL_MAX_BYTES,
  EXTERNAL_MAX_READERS,
  ExternalStatusSnapshotSchema,
} from '../src/external/resident-schema.ts';
import { nativeTurnState } from '../src/external/turnState.ts';
import { makeMachine, makeSession, UUID } from './helpers.ts';

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
const row = (id = UUID, type = 'active') => ({
  id,
  name: 'Native title',
  cwd: '/project',
  updatedAt: 1_787_900_000,
  status: { type, activeFlags: [] },
  preview: 'private body never exported',
  turns: [{ secret: true }],
});

async function fixture() {
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

test('resident HTTP reads and subscriptions share one provider connection without importing managed identities', async () => {
  const f = await fixture();
  await writeSessionsUnlocked(f.machine, [makeSession({ agent: 'codex', uuid: OTHER })]);
  await f.observer.refresh();
  const initial = await f.client.external();
  expect(ExternalStatusSnapshotSchema.parse(initial).status).toBe('live');
  expect(initial.sessions).toHaveLength(1);
  expect(initial.sessions[0]).toMatchObject({
    identity: { provider: 'codex', machine: 'host-a', threadId: UUID },
    name: 'Native title',
    turnState: { state: 'working' },
  });
  expect(JSON.stringify(initial)).not.toContain('private body');
  expect(JSON.stringify(initial)).not.toContain('secret');
  const requests = f.state.requests;
  const reads = await Promise.all(Array.from({ length: 100 }, () => f.client.external()));
  expect(reads.every((r) => r.sequence === initial.sequence)).toBe(true);
  const abort = new AbortController();
  const stream = await f.client.watchExternal.withOptions({ signal: abort.signal });
  expect((await stream.next()).value).toEqual(initial);
  const next = stream.next();
  f.provider.publish(
    'native-status',
    JSON.stringify({
      method: 'thread/status/changed',
      params: { threadId: UUID, status: { type: 'idle' } },
    }),
  );
  expect((await next).value.sessions[0]?.turnState.state).toBe('idle');
  expect(f.state.requests).toBe(requests);
  expect(f.state.connections).toBe(1);
  abort.abort();
  await stream.return?.();
  for (let i = 0; i < 100 && f.external.subscribers; i++) await Bun.sleep(5);
  expect(f.external.subscribers).toBe(0);
  await f.observer.refresh();
  expect(f.state.connections).toBe(1);
  expect([...f.state.methods].sort()).toEqual(['initialize', 'initialized', 'thread/list']);
});

test('a notification arriving during reconciliation wins over the older list response', async () => {
  const f = await fixture();
  f.state.race = true;
  await f.observer.refresh();
  expect(
    f.external.read().sessions.find((s) => s.identity.threadId === UUID)?.turnState.state,
  ).toBe('waiting-approval');
  f.state.race = false;
  f.state.rows = [];
  await f.observer.refresh();
  expect(f.external.read().sessions).toEqual([]);
});

test('native event states, unknown flags and future clocks remain distinct without refreshing unrelated leases', async () => {
  const f = await fixture();
  await f.observer.refresh();
  const baseline = f.external.read();
  const cases = [
    { status: { type: 'active', activeFlags: [] }, expected: 'working' },
    {
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      expected: 'waiting-approval',
    },
    { status: { type: 'active', activeFlags: ['waitingOnUserInput'] }, expected: 'waiting-input' },
    { status: { type: 'active', activeFlags: ['futureFlag'] }, expected: 'unknown' },
    { status: { type: 'idle' }, expected: 'idle' },
    { status: { type: 'notLoaded' }, expected: 'unknown' },
    { status: { type: 'systemError' }, expected: 'unknown' },
  ] satisfies { status: unknown; expected: ReturnType<typeof nativeTurnState>['state'] }[];
  const abort = new AbortController(),
    stream = await f.client.watchExternal.withOptions({ signal: abort.signal });
  await stream.next();
  for (const c of cases) {
    const next = stream.next();
    f.provider.publish(
      'native-status',
      JSON.stringify({
        method: 'thread/status/changed',
        params: { threadId: UUID, status: c.status },
      }),
    );
    const snapshot = ExternalStatusSnapshotSchema.parse((await next).value);
    expect(snapshot.sessions.find((s) => s.identity.threadId === UUID)?.turnState.state).toBe(
      c.expected,
    );
    expect(snapshot.expiresAt).toBe(baseline.expiresAt);
    expect(snapshot.sessions.find((s) => s.identity.threadId === OTHER)?.turnState).toEqual(
      baseline.sessions.find((s) => s.identity.threadId === OTHER)?.turnState,
    );
  }
  abort.abort();
  await stream.return?.();
  const future = currentExternalStatus(baseline, Date.parse(baseline.observedAt ?? '') - 1);
  expect(future.reason).toBe('clock-skew');
  expect(future.sessions.every((s) => s.turnState.state === 'unknown')).toBe(true);
});

test('cancel before connect, cancel pending reconciliation and configuration replacement cannot revive a retired generation', async () => {
  const f = await fixture();
  const before = new AbortController();
  before.abort();
  await f.observer.refresh(f.machine, before.signal);
  expect(f.state.connections).toBe(0);
  await f.observer.refresh();
  const generation = f.external.read().generation;
  f.state.hang = true;
  const stop = new AbortController(),
    pending = f.observer.refresh(f.machine, stop.signal);
  stop.abort();
  await pending;
  expect(f.external.read().status).toBe('unavailable');
  f.state.hang = false;
  await f.observer.refresh({ ...f.machine, codexHome: join(f.machine.stateDir, 'missing-root') });
  expect(f.external.read().status).toBe('unavailable');
  await f.observer.refresh();
  expect(f.external.read().generation).not.toBe(generation);
  expect(f.external.read().sessions[0]?.turnState.state).toBe('working');
});

test('deadline invalidates positives, reconnect replaces generation, and a failed host leaves another host untouched', async () => {
  const healthy = await fixture(),
    broken = await fixture();
  await Promise.all([healthy.observer.refresh(), broken.observer.refresh()]);
  const generation = broken.external.read().generation;
  broken.state.hang = true;
  await broken.observer.refresh();
  const unavailable = broken.external.read();
  expect(unavailable).toMatchObject({ status: 'unavailable', reason: 'deadline' });
  expect(unavailable.sessions).toHaveLength(2);
  for (const session of unavailable.sessions)
    expect(session.turnState).toMatchObject({ state: 'unknown', evidence: 'unavailable' });
  expect(healthy.external.read().sessions[0]?.turnState.state).toBe('working');
  broken.state.hang = false;
  broken.state.rows = [row(UUID, 'idle')];
  await broken.observer.refresh();
  expect(broken.external.read().generation).not.toBe(generation);
  expect(broken.external.read().sessions[0]?.turnState.state).toBe('idle');
  expect(broken.state.connections).toBe(2);
}, 7000);

test('expiry, malformed pages, unsupported runtime and root migration never infer idle', async () => {
  const f = await fixture();
  await f.observer.refresh();
  const initial = f.external.read();
  const expired = currentExternalStatus(initial, Date.parse(initial.expiresAt ?? '') + 1);
  expect(expired.status).toBe('stale');
  expect(expired.sessions).toHaveLength(2);
  for (const session of expired.sessions)
    expect(session.turnState).toMatchObject({ state: 'unknown', evidence: 'stale' });
  f.state.broken = true;
  await f.observer.refresh();
  expect(f.external.read()).toMatchObject({ status: 'unavailable', reason: 'invalid-response' });
  f.state.broken = false;
  f.state.version = 'codex/0.140.0';
  const count = f.state.requests;
  await f.observer.refresh();
  expect(f.state.requests).toBe(count);
  expect(f.external.read().reason).toBe('unsupported-runtime');
  await f.observer.refresh({ ...f.machine, stateDir: join(f.machine.stateDir, 'changed') });
  expect(f.external.read().reason).toBe('config-changed');
});

test('repeated cursors and closed provider connections fail closed; cancellation owns no provider threads', async () => {
  const f = await fixture();
  f.state.cursor = true;
  await f.observer.refresh();
  expect(f.external.read().status).toBe('unavailable');
  expect(f.state.requests).toBe(2);
  f.state.cursor = false;
  await f.observer.refresh();
  f.provider.stop(true);
  for (let i = 0; i < 100 && f.external.read().status === 'live'; i++) await Bun.sleep(5);
  expect(f.external.read().status).toBe('unavailable');
  expect([...f.state.methods]).not.toContain('thread/resume');
  expect([...f.state.methods]).not.toContain('turn/start');
});

test('reader queues coalesce, row/byte bounds declare omission, and stopped publishers reject new readers', async () => {
  const p = new ExternalStatusPublisher('host-a');
  const stops = Array.from({ length: EXTERNAL_MAX_READERS }, () => new AbortController());
  const streams = stops.map((s) => p.subscribe(s.signal)[Symbol.asyncIterator]());
  expect(() => p.subscribe(new AbortController().signal)).toThrow('limit');
  const rows = Array.from(
    { length: 513 },
    () =>
      ({
        identity: { provider: 'codex', machine: 'host-a', threadId: crypto.randomUUID() },
        name: 'x'.repeat(4096),
        dir: 'x'.repeat(4096),
        updatedAt: null,
        turnState: nativeTurnState({ type: 'idle' }, Date.now()),
      }) satisfies Parameters<typeof p.publish>[0][number],
  );
  for (let n = 0; n < 50; n++) p.publish(rows, false, Date.now());
  const read = p.read();
  expect(read.omitted).toBeGreaterThan(0);
  expect(read.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThan(EXTERNAL_MAX_BYTES);
  for (const stream of streams) expect((await stream.next()).value.sequence).toBe(read.sequence);
  for (const stop of stops) stop.abort();
  expect(p.subscribers).toBe(0);
  p.close();
  expect(() => p.subscribe(new AbortController().signal)).toThrow('stopped');
});

test('the real daemon owns observation across restart but never stops its external provider', async () => {
  const f = await fixture(),
    root = mkdtempSync('/tmp/ccmux-external-daemon-');
  const machine = {
    ...f.machine,
    stateDir: root,
    autoUpdate: false,
    chatEnabled: false,
    sessionEvents: false,
    tmuxSocket: `ccmux-external-${crypto.randomUUID()}`,
    tmuxBin: Bun.which('tmux') ?? '/usr/bin/false',
  };
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(machine));
  const env = {
    ...process.env,
    CCMUX_CONFIG: config,
    CCMUX_RC_PREFIX: machine.rcPrefix,
    CCMUX_STATE_DIR: root,
    CCMUX_DATA_DIR: join(root, 'data'),
    CCMUX_CACHE_DIR: join(root, 'cache'),
  };
  const start = () =>
    Bun.spawn(
      [process.execPath, '--no-env-file', join(import.meta.dir, '../src/cli.ts'), 'daemon'],
      { env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
    );
  let generation: string | undefined;
  try {
    for (let run = 0; run < 2; run++) {
      const daemon = start(),
        client = createControlClient({ socket: controlSocket(machine), timeoutMs: 1000 });
      const log = new Response(daemon.stderr).text();
      try {
        let live: Awaited<ReturnType<typeof client.external>> | undefined;
        for (let n = 0; n < 100; n++) {
          try {
            const result = await client.external();
            if (result.status === 'live') {
              live = result;
              break;
            }
          } catch {}
          await Bun.sleep(50);
        }
        expect(live?.sessions.map((s) => s.identity.threadId)).toEqual([UUID, OTHER]);
        expect(live?.generation).not.toBe(generation);
        generation = live?.generation;
        const abort = new AbortController(),
          stream = await client.watchExternal.withOptions({ signal: abort.signal });
        await stream.next();
        const next = stream.next();
        f.provider.publish(
          'native-status',
          JSON.stringify({
            method: 'thread/status/changed',
            params: { threadId: UUID, status: { type: 'idle' } },
          }),
        );
        // Read frames until the change shows, rather than demanding it in the very next one. The
        // stream emits a frame for any reason it has, so a refresh generated before the publish
        // landed can sit ahead of the one being waited for — and then the assertion reports the
        // state as never having changed, when it changed one frame later. It failed exactly that
        // way on a loaded machine, reading "working" where the sequence was correct.
        const stateOf = (frame: { value: { sessions: unknown[] } }) =>
          (
            frame.value.sessions as {
              identity: { threadId: string };
              turnState: { state: string };
            }[]
          ).find((s) => s.identity.threadId === UUID)?.turnState.state;
        //
        // Bounded in time as well as in frames, so that a change which never arrives fails saying
        // what it saw instead of hanging to the suite's own deadline — a timeout names the clock,
        // and the clock is not what is being asserted.
        const deadline = Date.now() + 10_000;
        let seen = stateOf(await next);
        for (let n = 0; n < 20 && seen !== 'idle' && Date.now() < deadline; n++) {
          const frame = await Promise.race([
            stream.next(),
            Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null),
          ]);
          if (frame === null) break;
          seen = stateOf(frame);
        }
        expect(seen).toBe('idle');
        abort.abort();
        await stream.return?.();
      } finally {
        await client.close();
        daemon.kill('SIGTERM');
        await daemon.exited;
        expect(await log).not.toContain('daemon resource failed');
      }
    }
    await f.observer.refresh();
    expect(f.external.read().status).toBe('live');
    expect([...f.state.methods].sort()).toEqual(['initialize', 'initialized', 'thread/list']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
