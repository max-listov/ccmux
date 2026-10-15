import { afterEach, expect, test } from 'bun:test';
import { acceptControlMessage } from '../src/control/message.ts';
import { respondControlNative } from '../src/control/nativeFeed.ts';
import { updateApplicationAuthority } from '../src/delegation/application.ts';
import { cancelDelegation, delegationStopped } from '../src/delegation/cancel.ts';
import { runtimeCapabilities } from '../src/runtime/capabilities.ts';
import { sleepSession, wakeSession } from '../src/session/sleep/operations.ts';
import { idleProof } from '../src/session/sleep/proof.ts';
import { steerNativeTurn } from '../src/steering/service.ts';
import { communicationAuthorization } from './communication-fixture.ts';
import { cleanup, ownedFixture, signal } from './fixtures/applicationAuthority.ts';
import { nativeCatalogFixture } from './fixtures/native-catalog.ts';

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
test('revoking a real owned authority releases its provider; foreign identical executable survives', async () => {
  const f = await ownedFixture();
  const foreign = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  cleanup.push(async () => {
    foreign.kill();
    await foreign.exited;
  });
  expect(idleProof(f.m, f.s).eligible).toBe(true);
  await updateApplicationAuthority(
    f.m,
    f.principal,
    { parent: f.authority.parent, operationId: crypto.randomUUID() },
    true,
  );
  const deadline = Date.now() + 3_000;
  while (f.child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
  expect(f.child.exitCode).toBe(0);
  expect(foreign.exitCode).toBeNull();
  expect(
    (
      await cancelDelegation(
        f.m,
        {
          parent: f.authority.parent,
          target: f.target,
          registrationGeneration: f.s.registrationGeneration ?? '',
          operationId: crypto.randomUUID(),
        },
        signal(),
      )
    ).stopped,
  ).toBe(true);
});

test('application children sleep with measured process release and cannot wake after their run closes', async () => {
  const f = await ownedFixture();
  const proof = idleProof(f.m, f.s);
  const receipt = await sleepSession(
    f.m,
    {
      target: f.target,
      registrationGeneration: f.s.registrationGeneration ?? '',
      revision: proof.revision,
      operationId: crypto.randomUUID(),
    },
    signal(),
  );
  expect(receipt.release).toBe('processReleased');
  await updateApplicationAuthority(
    f.m,
    f.principal,
    { parent: f.authority.parent, operationId: crypto.randomUUID() },
    true,
  );
  await expect(
    wakeSession(
      f.m,
      {
        target: f.target,
        registrationGeneration: f.s.registrationGeneration ?? '',
        operationId: crypto.randomUUID(),
      },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'DELEGATION_REFUSED' });
});

test('application message input pins the human reference before enqueue; steering and native answers cannot bypass it', async () => {
  const f = await ownedFixture();
  const catalog = nativeCatalogFixture(f.m, f.s);
  cleanup.push(async () => {
    await catalog.stop(true);
  });
  const input = {
    target: f.target,
    registrationGeneration: f.s.registrationGeneration,
    messageId: crypto.randomUUID(),
    body: 'synthetic input, no provider inference',
    defer: false,
    task: null,
    notBefore: null,
    images: [],
    origin: {
      applicationId: f.binding.applicationId,
      channelId: f.binding.channelId,
      actor: f.binding.actor,
    },
    communicationAuthorization,
  };
  await expect(
    acceptControlMessage(
      f.m,
      f.principal,
      {
        ...input,
        communicationAuthorization: {
          ...communicationAuthorization,
          sourceMessageRef: 'other-source',
        },
      },
      signal(),
    ),
  ).rejects.toThrow('human authorization');
  const accepted = await acceptControlMessage(f.m, f.principal, input, signal());
  expect(accepted.accepted).toBe(true);
  expect(accepted.duplicate).toBe(false);
  expect((await acceptControlMessage(f.m, f.principal, input, signal())).duplicate).toBe(true);
  expect(runtimeCapabilities(f.s)).toMatchObject({
    turnSteering: false,
    approval: false,
    input: false,
  });
  await expect(
    steerNativeTurn(
      f.m,
      f.principal,
      {
        target: f.target,
        registrationGeneration: f.s.registrationGeneration ?? '',
        operationId: crypto.randomUUID(),
        generation: crypto.randomUUID(),
        expectedTurnId: 'fixture-turn',
        body: 'bypass',
        images: [],
      },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'DELEGATION_REFUSED' });
  await expect(
    respondControlNative(
      f.m,
      {
        target: f.target,
        operationId: crypto.randomUUID(),
        generation: crypto.randomUUID(),
        requestId: 'fixture-request',
        kind: 'input',
        answers: { answer: ['bypass'] },
        decision: null,
      },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'DELEGATION_REFUSED' });
});

test('expired authority releases its owned process without a close request', async () => {
  const f = await ownedFixture(1_000);
  expect(f.child.exitCode).toBeNull();
  const deadline = Date.now() + 3_000;
  while (f.child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
  expect(f.child.exitCode).toBe(0);
  expect(delegationStopped(f.m, f.s)).toBe(true);
});
