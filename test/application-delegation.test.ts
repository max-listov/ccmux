import { afterEach, expect, test } from 'bun:test';
import { managedPeer, servicePrincipal } from '../src/chat/identity.ts';
import { createControlSession } from '../src/control/lifecycle.ts';
import { acceptControlMessage } from '../src/control/message.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import {
  applicationAuthorityCapabilities,
  openApplicationAuthority,
  requireApplicationAuthority,
  requireApplicationInput,
  updateApplicationAuthority,
} from '../src/delegation/application.ts';
import { delegationStopped } from '../src/delegation/cancel.ts';
import { resolveDelegation } from '../src/delegation/resolve.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/session/registry.ts';
import { communicationAuthorization } from './communication-fixture.ts';
import { cleanup, fixture, signal } from './fixtures/applicationAuthority.ts';
import { makeSession } from './helpers.ts';

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
test('typed owner socket creates both runtimes from an application authority without a fake parent session', async () => {
  const f = fixture();
  let calls = 0;
  const p = new ControlPublisher(f.m);
  const owned = createControlServer(f.m, p, undefined, () => f.m, undefined, {
    createManagedSession: async (m, input) => {
      calls++;
      expect(loadSessions(m).every((s) => s.name !== 'parent')).toBe(true);
      const nativeId = crypto.randomUUID();
      const s = makeSession({
        uuid: nativeId,
        ...(input.agent === 'claude'
          ? { nativeSession: { runtime: 'claude', id: nativeId, version: 'fixture' } }
          : {}),
        ...input,
        name: input.name,
        dir: input.dir,
        agent: input.agent,
        runtime: input.runtime,
        registrationGeneration: input.registrationGeneration,
        delegation: input.delegation,
        chat: true,
      });
      await writeSessionsUnlocked(m, [...loadSessions(m), s]);
      return s;
    },
  });
  const client = createControlClient({ socket: controlSocket(f.m) });
  cleanup.push(async () => {
    await client.close();
    p.close();
    await owned.server.shutdown({ gracePeriodMs: 100, forceTimeoutMs: 100 });
    await owned.observability.close();
  });
  expect((await client['delegation.application.capabilities']({})).bindings).toHaveLength(1);
  const authority = await client['delegation.application.open'](f.input);
  expect(authority.assurance).toBe('application-attested');
  expect(await client['delegation.application.open'](f.input)).toEqual(authority);
  for (const runtime of ['codex', 'claude'] as const) {
    const request = {
      name: `${runtime}-child`,
      requestId: crypto.randomUUID(),
      workspace: f.root,
      runtime,
      mode: 'native' as const,
      delegation: { parent: authority.parent, policy: f.policy },
    };
    const first = await client['session.create'](request);
    expect(first.delegation?.delegation.applicationAuthority).toEqual(authority.parent);
    expect(first.delegation?.delegation.policy).toEqual(f.policy);
    expect(first.delegation?.state).toBe('unavailable'); // No synthetic native acknowledgement.
    expect((await client['session.create'](request)).duplicate).toBe(true);
  }
  expect(calls).toBe(2);
  expect(loadSessions(f.m)).toHaveLength(2);
  await expect(
    client['session.create']({
      name: 'escape',
      workspace: f.root,
      requestId: crypto.randomUUID(),
      runtime: 'codex',
      mode: 'native',
      delegation: { parent: authority.parent, policy: { ...f.policy, access: 'workspace-write' } },
    }),
  ).rejects.toMatchObject({ code: 'DELEGATION_REFUSED' });
  expect(calls).toBe(2);
  await client['delegation.application.close']({
    parent: authority.parent,
    operationId: crypto.randomUUID(),
  });
  expect(loadSessions(f.m).every((s) => delegationStopped(f.m, s))).toBe(true);
});

test('issuer, application binding, parent generation, run operation and maximum rights are pinned', async () => {
  const f = fixture(),
    authority = await openApplicationAuthority(f.m, f.principal, f.input);
  for (const binding of [
    { ...f.binding, applicationId: 'unknown' },
    { ...f.binding, channelId: 'composer' },
    { ...f.binding, actor: 'human' },
    { ...f.binding, revision: 'old' },
  ])
    await expect(
      openApplicationAuthority(f.m, f.principal, {
        ...f.input,
        binding: binding as typeof f.binding,
      }),
    ).rejects.toThrow();
  const foreign = servicePrincipal('host-b', 'declared-service');
  expect(applicationAuthorityCapabilities(f.m, foreign).bindings).toEqual([]);
  expect(() => requireApplicationAuthority(f.m, foreign, authority.parent)).toThrow();
  expect(() => requireApplicationAuthority(f.m, undefined, authority.parent)).toThrow('issuer');
  for (const parent of [
    { ...authority.parent, registrationGeneration: crypto.randomUUID() },
    {
      ...authority.parent,
      target: { ...authority.parent.target, authorityId: crypto.randomUUID() },
    },
    { ...authority.parent, target: { ...authority.parent.target, applicationId: 'unknown' } },
  ])
    expect(() => requireApplicationAuthority(f.m, f.principal, parent)).toThrow('unavailable');
  await expect(
    openApplicationAuthority(f.m, f.principal, { ...f.input, runId: 'forged-run' }),
  ).rejects.toThrow('conflicts');
  let starts = 0;
  await expect(
    createControlSession(
      f.m,
      {
        name: 'forged',
        requestId: crypto.randomUUID(),
        workspace: f.root,
        runtime: 'codex',
        mode: 'native',
        delegation: { parent: authority.parent, policy: f.policy },
      },
      signal(),
      async () => {
        starts++;
        throw Error('must not launch');
      },
    ),
  ).rejects.toThrow('issuer');
  expect(starts).toBe(0);
  requireApplicationInput(
    f.m,
    f.principal,
    authority.parent,
    f.binding,
    communicationAuthorization,
  );
  for (const authorization of [
    { ...communicationAuthorization, sourceMessageRef: 'other-human-message' },
    { ...communicationAuthorization, userAuthorizationQuote: 'invented quote' },
  ])
    expect(() =>
      requireApplicationInput(f.m, f.principal, authority.parent, f.binding, authorization),
    ).toThrow('human authorization');
});

test('renewal uses CAS, retries do not extend it, and closed or expired runs cannot be resurrected', async () => {
  const f = fixture(1_000),
    authority = await openApplicationAuthority(f.m, f.principal, f.input);
  const update = {
    parent: authority.parent,
    operationId: crypto.randomUUID(),
    expectedExpiresAt: authority.expiresAt,
  };
  await Bun.sleep(5);
  const renewed = await updateApplicationAuthority(f.m, f.principal, update, false);
  expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(authority.expiresAt));
  expect(await updateApplicationAuthority(f.m, f.principal, update, false)).toEqual(renewed);
  await expect(
    updateApplicationAuthority(
      f.m,
      f.principal,
      { ...update, operationId: crypto.randomUUID() },
      false,
    ),
  ).rejects.toThrow('stale');
  await expect(
    updateApplicationAuthority(
      f.m,
      f.principal,
      { ...update, expectedExpiresAt: '2000-01-01T00:00:00.000Z' },
      false,
    ),
  ).rejects.toThrow('conflicts');
  const later = await updateApplicationAuthority(
    f.m,
    f.principal,
    {
      parent: authority.parent,
      operationId: crypto.randomUUID(),
      expectedExpiresAt: renewed.expiresAt,
    },
    false,
  );
  expect(await updateApplicationAuthority(f.m, f.principal, update, false)).toEqual(renewed);
  expect(requireApplicationAuthority(f.m, f.principal, authority.parent).expiresAt).toBe(
    later.expiresAt,
  );
  const closed = await updateApplicationAuthority(
    f.m,
    f.principal,
    { parent: authority.parent, operationId: crypto.randomUUID() },
    true,
  );
  expect(closed.closedAt).not.toBeNull();
  await expect(
    updateApplicationAuthority(
      f.m,
      f.principal,
      { ...update, operationId: crypto.randomUUID(), expectedExpiresAt: renewed.expiresAt },
      false,
    ),
  ).rejects.toThrow('ended');
  await expect(openApplicationAuthority(f.m, f.principal, f.input)).rejects.toThrow('ended');
  const another = await openApplicationAuthority(f.m, f.principal, {
    ...f.input,
    operationId: crypto.randomUUID(),
  });
  const deadline = Date.now() + 2_000;
  while (Date.now() < Date.parse(another.expiresAt) && Date.now() < deadline) await Bun.sleep(10);
  await expect(
    updateApplicationAuthority(
      f.m,
      f.principal,
      {
        parent: another.parent,
        operationId: crypto.randomUUID(),
        expectedExpiresAt: another.expiresAt,
      },
      false,
    ),
  ).rejects.toThrow('ended');
});

test('application root is inherited; unrelated managed input and new descendants after close are refused', async () => {
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
    name: 'child',
    dir: f.root,
    agent: 'codex',
    runtime: 'app-server',
    chat: true,
    registrationGeneration: crypto.randomUUID(),
    delegation,
  });
  const unrelated = makeSession({
    name: 'unrelated',
    dir: f.root,
    registrationGeneration: crypto.randomUUID(),
  });
  await writeSessionsUnlocked(f.m, [parent, unrelated]);
  const inherited = resolveDelegation(
    f.m,
    'codex',
    'app-server',
    f.root,
    crypto.randomUUID(),
    {
      parent: {
        target: managedPeer(f.m.rcPrefix, parent),
        registrationGeneration: parent.registrationGeneration ?? '',
      },
      policy: f.policy,
    },
    managedPeer(f.m.rcPrefix, parent),
  );
  expect(inherited.applicationAuthority).toEqual(authority.parent);
  await expect(
    acceptControlMessage(
      f.m,
      managedPeer(f.m.rcPrefix, unrelated),
      {
        target: managedPeer(f.m.rcPrefix, parent),
        registrationGeneration: parent.registrationGeneration,
        messageId: crypto.randomUUID(),
        body: 'unauthorized input',
        communicationAuthorization,
        defer: false,
        notBefore: null,
        task: null,
        images: [],
      },
      signal(),
    ),
  ).rejects.toThrow('exact active application descendant parent');
  await updateApplicationAuthority(
    f.m,
    f.principal,
    { parent: authority.parent, operationId: crypto.randomUUID() },
    true,
  );
  expect(delegationStopped(f.m, parent)).toBe(true);
  expect(() =>
    resolveDelegation(
      f.m,
      'codex',
      'app-server',
      f.root,
      crypto.randomUUID(),
      {
        parent: {
          target: managedPeer(f.m.rcPrefix, parent),
          registrationGeneration: parent.registrationGeneration ?? '',
        },
        policy: f.policy,
      },
      f.principal,
    ),
  ).toThrow('ended');
});
