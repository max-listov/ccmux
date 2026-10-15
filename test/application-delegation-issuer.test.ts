import { afterEach, expect, test } from 'bun:test';
import { createClient, createHttpClient } from 'stitchkit';
import { createUnixClientTransport } from 'stitchkit/server';
import { managedPeer, servicePrincipal } from '../src/chat/identity.ts';
import { createControlSession } from '../src/control/lifecycle.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { controlContract } from '../src/control/schema/contract.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { openApplicationAuthority } from '../src/delegation/application.ts';
import { resolveDelegation } from '../src/delegation/resolve.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/session/registry.ts';
import { cleanup, fixture, signal } from './fixtures/applicationAuthority.ts';
import { makeSession } from './helpers.ts';

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test('foreign service cannot inherit, resume create receipts or cancel through a managed application parent', async () => {
  const f = fixture(),
    authority = await openApplicationAuthority(f.m, f.principal, f.input);
  const delegation = resolveDelegation(
    f.m,
    'codex',
    'app-server',
    f.root,
    crypto.randomUUID(),
    { parent: authority.parent, policy: f.policy },
    f.principal,
  );
  const parent = makeSession({
    name: 'native-child',
    agent: 'codex',
    runtime: 'app-server',
    dir: f.root,
    registrationGeneration: crypto.randomUUID(),
    delegation,
  });
  await writeSessionsUnlocked(f.m, [parent]);
  const reference = {
    target: managedPeer(f.m.rcPrefix, parent),
    registrationGeneration: parent.registrationGeneration ?? '',
  };
  const foreign = servicePrincipal('host-b', 'declared-service');
  expect(() =>
    resolveDelegation(
      f.m,
      'codex',
      'app-server',
      f.root,
      crypto.randomUUID(),
      { parent: reference, policy: f.policy },
      foreign,
    ),
  ).toThrow();
  let starts = 0;
  const create = async () => {
    starts++;
    throw Error('not launched');
  };
  const request = {
    requestId: crypto.randomUUID(),
    name: 'grandchild',
    workspace: f.root,
    runtime: 'codex' as const,
    mode: 'native' as const,
    delegation: { parent: reference, policy: f.policy },
  };
  await expect(
    createControlSession(f.m, request, signal(), create, undefined, undefined, foreign),
  ).rejects.toThrow();
  expect(starts).toBe(0);
  await createControlSession(
    f.m,
    request,
    signal(),
    async (machine, input) => {
      const child = makeSession({ ...input, uuid: crypto.randomUUID(), chat: true });
      await writeSessionsUnlocked(machine, [parent, child]);
      return child;
    },
    undefined,
    undefined,
    f.principal,
  );
  await expect(
    createControlSession(f.m, request, signal(), create, undefined, undefined, foreign),
  ).rejects.toThrow();
  expect(starts).toBe(0);
  const p = new ControlPublisher(f.m);
  const owned = createControlServer(f.m, p);
  const transport = createUnixClientTransport({
    socketPath: controlSocket(f.m),
    maxRequestBytes: 65536,
    maxHeaderBytes: 16384,
    maxResponseBytes: 1048576,
    maxConnections: 4,
    headersTimeoutMs: 5000,
  });
  const client = createClient(
    controlContract,
    createHttpClient({
      baseUrl: 'http://ccmux.local',
      fetch: transport.fetch,
      headers: { 'x-ccmux-caller': foreign.machine },
      retry: { limit: 0 },
    }),
  );
  cleanup.push(async () => {
    await transport.close();
    p.close();
    await owned.server.shutdown({ gracePeriodMs: 100, forceTimeoutMs: 100 });
    await owned.observability.close();
  });
  await expect(client['session.create'](request)).rejects.toMatchObject({ code: 'ORIGIN_REFUSED' });
  const child = loadSessions(f.m).find((session) => session.name === 'grandchild');
  if (!child) throw Error('accepted child missing');
  const target = managedPeer(f.m.rcPrefix, child),
    registrationGeneration = child.registrationGeneration ?? '';
  for (const attempt of [
    () => client['session.archive']({ target }),
    () => client['session.start']({ target }),
    () =>
      client['session.sleep']({
        target,
        registrationGeneration,
        operationId: crypto.randomUUID(),
        revision: '0'.repeat(64),
      }),
    () =>
      client['session.wake']({ target, registrationGeneration, operationId: crypto.randomUUID() }),
    () =>
      client['turn.interrupt']({ target, generation: crypto.randomUUID(), turnId: 'fixture-turn' }),
  ])
    await expect(attempt()).rejects.toMatchObject({ code: 'ORIGIN_REFUSED' });
  expect(loadSessions(f.m).find((session) => session.name === child.name)?.archived).not.toBe(true);
  await expect(
    client['delegation.cancel']({
      parent: reference,
      target: managedPeer(f.m.rcPrefix, child),
      registrationGeneration: child.registrationGeneration ?? '',
      operationId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'ORIGIN_REFUSED' });
});
