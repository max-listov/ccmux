import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { managedPeer, servicePrincipal } from '../src/chat/identity.ts';
import { createControlSession } from '../src/control/lifecycle.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createInjectedControlClient } from '../src/control/transport/boundary.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { openApplicationAuthority } from '../src/delegation/application.ts';
import { resolveDelegation } from '../src/delegation/resolve.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/session/registry.ts';
import { declaredServiceConfig, declaredServiceFetch, grantCallers } from './declared-service.ts';
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
  // The foreign machine reaches this daemon as a caller of its declared service, granted each
  // operation it tries; the refusals below are the application authority's, not the grant's.
  const services = join(f.root, 'services');
  grantCallers(
    services,
    [
      'session.create',
      'session.archive',
      'session.start',
      'session.sleep',
      'session.wake',
      'turn.interrupt',
      'delegation.cancel',
    ].map((operation) => ({ caller: foreign.machine, scope: { kind: 'operation', operation } })),
  );
  const served = { ...f.m, ...declaredServiceConfig(services) };
  const p = new ControlPublisher(served);
  const owned = createControlServer(served, p);
  await owned.wire?.start();
  const client = createInjectedControlClient(
    declaredServiceFetch(controlSocket(served), foreign.machine),
  );
  cleanup.push(async () => {
    await owned.wire?.close();
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
