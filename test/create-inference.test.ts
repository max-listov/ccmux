import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadCreateReceipts } from '../src/control/createReceipts.ts';
import { createControlSession } from '../src/control/lifecycle.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { ControlCreateSchema } from '../src/control/schema/session.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { readRuntimeCatalog } from '../src/runtime/catalog.ts';
import { loadPendingSessions } from '../src/session/pending.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/session/registry.ts';
import { makeMachine, makeSession } from './helpers.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const root = mkdtempSync('/tmp/ccmux-inference-test-');
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  return { root, m: makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' }) };
}

test('catalog names the inference boundary of every creatable runtime and mode', () => {
  const { m } = fixture();
  const rows = readRuntimeCatalog(m).runtimes;
  expect(rows).toHaveLength(5);
  for (const row of rows) {
    expect(row.capabilities.creation.noInference).toBe(false);
    expect(row.capabilities.creation).toEqual(
      row.runtime === 'codex'
        ? {
            noInference: false,
            inference: 'required',
            reason: 'native-rollout-requires-bootstrap',
          }
        : {
            noInference: false,
            inference: 'not-guaranteed',
            reason: 'provider-initialization-not-certified',
          },
    );
  }
});

test('typed no-inference create refuses every adapter before provider effects or receipt reservation', async () => {
  const { root, m } = fixture();
  let providerRequests = 0,
    createCalls = 0,
    discoveryCalls = 0;
  const endpoint = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      providerRequests++;
      return Response.json({ ok: true });
    },
  });
  cleanup.push(async () => {
    endpoint.stop(true);
  });
  const publisher = new ControlPublisher(m);
  const owned = createControlServer(m, publisher, undefined, () => m, undefined, {
    createManagedSession: async (_m, input) => {
      createCalls++;
      await fetch(endpoint.url);
      const session = makeSession({ ...input, uuid: crypto.randomUUID() });
      await writeSessionsUnlocked(m, [session]);
      return session;
    },
  });
  const client = createControlClient({ socket: controlSocket(m) });
  cleanup.push(async () => {
    await client.close();
    publisher.close();
    await owned.server.shutdown({ gracePeriodMs: 100, forceTimeoutMs: 100 });
    await owned.observability.close();
  });
  for (const row of readRuntimeCatalog(m).runtimes) {
    const input = ControlCreateSchema.parse({
      runtime: row.runtime,
      mode: row.mode === 'tui' ? 'tui' : 'native',
      initialization: 'no-inference',
      requestId: crypto.randomUUID(),
      name: 'worker',
      workspace: root,
    });
    for (let retry = 0; retry < 2; retry++)
      await expect(client['session.create'](input)).rejects.toMatchObject({
        code: 'NO_INFERENCE_CREATE_UNSUPPORTED',
      });
  }
  await expect(
    createControlSession(
      m,
      {
        requestId: crypto.randomUUID(),
        name: 'discovery',
        workspace: '/missing/workspace',
        initialization: 'no-inference',
        modelSelection: { provider: 'unused', model: 'unused' },
      },
      AbortSignal.timeout(5000),
      async () => {
        throw new Error('create must not run');
      },
      async () => {
        discoveryCalls++;
      },
    ),
  ).rejects.toMatchObject({ code: 'NO_INFERENCE_CREATE_UNSUPPORTED' });
  expect({ providerRequests, createCalls, discoveryCalls }).toEqual({
    providerRequests: 0,
    createCalls: 0,
    discoveryCalls: 0,
  });
  expect(loadCreateReceipts(m)).toEqual([]);
  expect(loadPendingSessions(m)).toEqual([]);
  expect(loadSessions(m)).toEqual([]);
  expect(existsSync(join(m.stateDir, 'control', 'create-requests.json'))).toBe(false);
  // Independent positive control proves the controlled endpoint is reachable and counts requests.
  expect((await fetch(endpoint.url)).status).toBe(200);
  expect(providerRequests).toBe(1);
});

test('completed ordinary create cannot be relabelled inference-free by retry; allowed retries keep one identity', async () => {
  const { root, m } = fixture();
  const input = { requestId: crypto.randomUUID(), name: 'worker', workspace: root };
  let calls = 0;
  const create = async (_m: typeof m, fields: Parameters<typeof makeSession>[0]) => {
    calls++;
    const session = makeSession({ ...fields, uuid: crypto.randomUUID() });
    await writeSessionsUnlocked(m, [session]);
    return session;
  };
  const first = await createControlSession(m, input, AbortSignal.timeout(5_000), create);
  const retry = await createControlSession(
    m,
    { ...input, initialization: 'allow-inference' },
    AbortSignal.timeout(5_000),
    create,
  );
  expect(retry.target).toEqual(first.target);
  expect(retry.duplicate).toBe(true);
  await expect(
    createControlSession(
      m,
      { ...input, initialization: 'no-inference' },
      AbortSignal.timeout(5_000),
      create,
    ),
  ).rejects.toMatchObject({ code: 'NO_INFERENCE_CREATE_UNSUPPORTED' });
  expect(calls).toBe(1);
  expect(loadSessions(m)).toHaveLength(1);
});
