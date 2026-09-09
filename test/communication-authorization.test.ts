import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  readCommunicationAuthorization,
  requireCommunicationAuthorization,
} from '../src/chat/communicationAuthorization.ts';
import { CommunicationAuthorizationSchema } from '../src/chat/communicationAuthorizationSchema.ts';
import { LogFrameSchema } from '../src/chat/feedSchema.ts';
import { rowFromLedgerRecord, rowFromOutbound } from '../src/chat/fleetLog.ts';
import { managedPeer, servicePrincipal } from '../src/chat/identity.ts';
import { boundFrame, MAX_FRAME_BYTES } from '../src/chat/logFeed.ts';
import { principalOrigin } from '../src/chat/origin.ts';
import { appendMessage, chatPaths, loadLedger } from '../src/chat/store.ts';
import { ChatMessageSchema } from '../src/config/schema.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { acceptControlMessage } from '../src/control/message.ts';
import { ControlMessageSchema } from '../src/control/schema.ts';
import {
  communicationAuthorization,
  communicationAuthorizationFile,
} from './communication-fixture.ts';
import {
  makeAppPeer,
  makeChatMessage,
  makeCli,
  makeMachine,
  makePeer,
  makeSession,
} from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync('/tmp/ccmux-consent-');
  roots.push(path);
  return path;
}

test('contract requires the object; bounds reject empty claims and preserve the verbatim quote', async () => {
  const input = { target: makePeer(), messageId: crypto.randomUUID(), body: 'hello' };
  expect(ControlMessageSchema.safeParse(input).success).toBe(false);
  expect(z.toJSONSchema(ControlMessageSchema, { io: 'input' }).required).toContain(
    'communicationAuthorization',
  );
  for (const invalid of [
    {},
    { ...communicationAuthorization, userAuthorizationQuote: ' \n ' },
    { ...communicationAuthorization, sourceMessageRef: ' ' },
    {
      ...communicationAuthorization,
      whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope: 'because I can',
    },
    { ...communicationAuthorization, userAuthorizationQuote: 'x'.repeat(4001) },
    { ...communicationAuthorization, approved: true },
  ])
    expect(CommunicationAuthorizationSchema.safeParse(invalid).success).toBe(false);
  const quote = '  Send the fixture message.\n';
  expect(
    CommunicationAuthorizationSchema.parse({
      ...communicationAuthorization,
      userAuthorizationQuote: quote,
    }).userAuthorizationQuote,
  ).toBe(quote);
  expect(await readCommunicationAuthorization(communicationAuthorizationFile)).toEqual(
    communicationAuthorization,
  );
  const dir = root();
  await expect(readCommunicationAuthorization(dir)).rejects.toThrow('regular');
  const oversized = join(dir, 'oversized.json');
  writeFileSync(oversized, ' '.repeat(64 * 1024 + 1));
  await expect(readCommunicationAuthorization(oversized)).rejects.toThrow('64 KiB');
});

test('agent, App and unclassified callers cannot omit evidence', () => {
  for (const from of [makePeer(), makeAppPeer(), makeCli(), servicePrincipal('host-a', 'local')]) {
    expect(() => requireCommunicationAuthorization(from, principalOrigin(from), null)).toThrow(
      'communicationAuthorization is required',
    );
    expect(() =>
      requireCommunicationAuthorization(from, principalOrigin(from), communicationAuthorization),
    ).not.toThrow();
  }
});

async function fixture() {
  const m = makeMachine({
    stateDir: root(),
    rcPrefix: 'host-a',
    chatEnabled: true,
    messageApplications: {
      app: {
        revision: '1',
        callers: ['host-b'],
        channels: ['chat'],
        actors: ['human', 'agent'],
        ownerNotifications: false,
      },
    },
  });
  const registrationGeneration = crypto.randomUUID();
  const session = makeSession({ chat: true, dir: m.stateDir, registrationGeneration });
  await writeSessionsUnlocked(m, [session]);
  return {
    m,
    input: {
      target: managedPeer(m.rcPrefix, session),
      registrationGeneration,
      messageId: crypto.randomUUID(),
      body: 'message text',
      communicationAuthorization,
    },
    signal: new AbortController().signal,
  };
}

test('control refuses before append and immutable evidence survives accepted retry', async () => {
  const f = await fixture();
  const from = makeCli('host-b');
  await expect(
    acceptControlMessage(f.m, from, { ...f.input, communicationAuthorization: null }, f.signal),
  ).rejects.toMatchObject({ code: 'COMMUNICATION_AUTHORIZATION_REQUIRED' });
  expect(loadLedger(f.m)).toEqual([]);
  expect((await acceptControlMessage(f.m, from, f.input, f.signal)).duplicate).toBe(false);
  expect((await acceptControlMessage(f.m, from, f.input, f.signal)).duplicate).toBe(true);
  for (const field of [
    'userAuthorizationQuote',
    'sourceMessageRef',
    'whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope',
  ]) {
    await expect(
      acceptControlMessage(
        f.m,
        from,
        {
          ...f.input,
          communicationAuthorization: {
            ...communicationAuthorization,
            [field]: 'Different evidence whose rationale is long enough to be valid.',
          },
        },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  }
  expect(loadLedger(f.m)).toHaveLength(1);
  expect(loadLedger(f.m)[0]).toMatchObject({ body: 'message text', communicationAuthorization });
});

test('only a bound human service channel can submit explicit null', async () => {
  const f = await fixture();
  const humanInput = {
    ...f.input,
    communicationAuthorization: null,
    origin: { applicationId: 'app', channelId: 'chat', actor: 'human' },
  } satisfies Parameters<typeof acceptControlMessage>[2];
  await expect(acceptControlMessage(f.m, makePeer(), humanInput, f.signal)).rejects.toMatchObject({
    code: 'ORIGIN_REFUSED',
  });
  await expect(
    acceptControlMessage(f.m, servicePrincipal('host-c', 'declared-service'), humanInput, f.signal),
  ).rejects.toMatchObject({ code: 'ORIGIN_REFUSED' });
  const service = servicePrincipal('host-b', 'declared-service');
  await expect(
    acceptControlMessage(
      f.m,
      service,
      { ...humanInput, origin: { ...humanInput.origin, actor: 'agent' } },
      f.signal,
    ),
  ).rejects.toMatchObject({ code: 'COMMUNICATION_AUTHORIZATION_REQUIRED' });
  expect(loadLedger(f.m)).toHaveLength(0);
  expect((await acceptControlMessage(f.m, service, humanInput, f.signal)).accepted).toBe(true);
  expect(loadLedger(f.m)[0]?.origin?.actor).toBe('human');
});

test('history absence stays absent; projections retain complete evidence without changing body', () => {
  const m = makeMachine({ stateDir: root() });
  const historical = makeChatMessage();
  delete historical.communicationAuthorization;
  appendMessage(m, historical);
  const before = readFileSync(chatPaths(m).ledger, 'utf8');
  expect(loadLedger(m)[0]).not.toHaveProperty('communicationAuthorization');
  expect(rowFromLedgerRecord('host-a', loadLedger(m)[0] ?? null)).not.toHaveProperty(
    'communicationAuthorization',
  );
  expect(readFileSync(chatPaths(m).ledger, 'utf8')).toBe(before);
  const message = ChatMessageSchema.parse(makeChatMessage({ id: crypto.randomUUID() }));
  const row = rowFromLedgerRecord('host-a', message);
  expect(row).toMatchObject({ body: 'hello', communicationAuthorization });
  expect(
    rowFromOutbound('host-a', {
      kind: 'msg',
      envelope: message,
      result: { ok: false, detail: 'unknown' },
    }).communicationAuthorization,
  ).toEqual(communicationAuthorization);
  const large = {
    ...row,
    communicationAuthorization: {
      ...communicationAuthorization,
      userAuthorizationQuote: '\u0000'.repeat(4000),
      whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope: '\u0000'.repeat(4000),
    },
  };
  const frame = boundFrame({ kind: 'row', cursor: 'unchanged', row: large });
  expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  expect(LogFrameSchema.safeParse(frame).success).toBe(true);
  expect(frame).toMatchObject({
    cursor: 'unchanged',
    row: {
      messageId: message.id,
      note: expect.stringContaining('communication authorization omitted'),
    },
  });
  expect(large.communicationAuthorization.userAuthorizationQuote).toHaveLength(4000);
});

test("a human's message reaches an ordinary session, which has no generation to pin", async () => {
  // The route this whole exemption exists for, and the one that was closed: an application delivering
  // a person's message to a plain pane. Attributed input must pin the exact registration — but only a
  // session that HAS one can be pinned, and most sessions are ordinary panes rather than native
  // runtimes (measured on a live machine: 1 of 15). Asked of the request alone, the requirement read
  // "supply a value that does not exist", so the human channel had no honest route at all: with
  // attribution it was refused for the missing pin, without it for the missing justification.
  const f = await fixture();
  const plain = makeSession({ name: 'agent-b', chat: true, dir: f.m.stateDir });
  expect(plain.registrationGeneration).toBeUndefined();
  await writeSessionsUnlocked(f.m, [plain]);
  const service = servicePrincipal('host-b', 'declared-service');
  const accepted = await acceptControlMessage(
    f.m,
    service,
    {
      target: managedPeer(f.m.rcPrefix, plain),
      messageId: crypto.randomUUID(),
      body: "a person's message",
      communicationAuthorization: null,
      origin: { applicationId: 'app', channelId: 'chat', actor: 'human' },
    },
    f.signal,
  );
  expect(accepted.accepted).toBe(true);
  expect(loadLedger(f.m)).toHaveLength(1);
});

test('a session that HAS a generation still refuses attributed input that does not pin it', async () => {
  // The other half: where the pin is possible it stays mandatory, so a person's message cannot land
  // on a registration that was replaced underneath it.
  const f = await fixture();
  const service = servicePrincipal('host-b', 'declared-service');
  await expect(
    acceptControlMessage(
      f.m,
      service,
      {
        ...f.input,
        registrationGeneration: undefined,
        communicationAuthorization: null,
        origin: { applicationId: 'app', channelId: 'chat', actor: 'human' },
      },
      f.signal,
    ),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  expect(loadLedger(f.m)).toHaveLength(0);
});
