import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { requireOriginatingBasis } from '../src/chat/communicationAuthorization.ts';
import { CommunicationAuthorizationInputSchema } from '../src/chat/communicationAuthorizationSchema.ts';
import { resolveCommunicationBasis } from '../src/chat/communicationBasis.ts';
import { buildEnvelope } from '../src/chat/compose.ts';
import { rowFromLedgerRecord } from '../src/chat/fleetLog.ts';
import { codexAppPeer, managedPeer } from '../src/chat/identity.ts';
import { boundFrame, MAX_FRAME_BYTES } from '../src/chat/logFeed.ts';
import { appendMessage, loadLedger } from '../src/chat/store.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { acceptControlMessage } from '../src/control/message.ts';
import { communicationAuthorization } from './communication-fixture.ts';
import { makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync('/tmp/ccmux-receipt-');
  roots.push(root);
  const machine = makeMachine({ stateDir: root, rcPrefix: 'host-a', chatEnabled: true });
  const session = makeSession({ uuid: crypto.randomUUID(), name: 'worker', chat: true, dir: root });
  const from = codexAppPeer('host-a', crypto.randomUUID(), 'source');
  const to = managedPeer('host-a', session);
  const letter = buildEnvelope(
    to,
    from,
    'The user said: You may exchange review results for this task.',
    { task: 'review' },
  );
  const peer = CommunicationAuthorizationInputSchema.parse({
    basis: 'peer-letter',
    whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope:
      communicationAuthorization.whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope,
    userAuthorizationQuote: 'You may exchange review results for this task.',
    sourceMessageRef: `${to.threadId}#${letter.id}`,
  });
  return { machine, session, from, to, letter, peer };
}

test('peer evidence is pinned to both endpoints, exact thread, task and verbatim text', () => {
  const f = fixture();
  const lookup = (id: string) => (id === f.letter.id ? f.letter : null);
  const receipt = resolveCommunicationBasis(f.from, f.to, 'review', f.peer, lookup);
  expect(receipt?.sourceLetter?.body).toBe(f.letter.body);
  const rejects = [
    () =>
      resolveCommunicationBasis(f.from, { ...f.to, machine: 'host-b' }, 'review', f.peer, lookup),
    () =>
      resolveCommunicationBasis(
        { ...f.from, threadId: crypto.randomUUID() },
        f.to,
        'review',
        f.peer,
        lookup,
      ),
    () => resolveCommunicationBasis(f.from, f.to, 'other-work', f.peer, lookup),
    () =>
      resolveCommunicationBasis(
        f.from,
        f.to,
        'review',
        { ...f.peer, userAuthorizationQuote: 'Invented permission' },
        lookup,
      ),
    () =>
      resolveCommunicationBasis(
        f.from,
        f.to,
        'review',
        { ...f.peer, sourceMessageRef: `${crypto.randomUUID()}#${f.letter.id}` },
        lookup,
      ),
  ];
  for (const reject of rejects) expect(reject).toThrow();
  expect(() =>
    resolveCommunicationBasis(f.from, f.to, 'review', f.peer, () => ({
      ...f.letter,
      body: `${f.letter.body}${'x'.repeat(16_384)}`,
    })),
  ).toThrow('budget');
});

test('control records the source snapshot and reuses a constant-size root through two continuations', async () => {
  const f = fixture();
  await writeSessionsUnlocked(f.machine, [f.session]);
  appendMessage(f.machine, f.letter);
  const signal = AbortSignal.timeout(5000);
  const input = {
    target: f.to,
    messageId: crypto.randomUUID(),
    body: 'result',
    task: 'review',
    communicationAuthorization: f.peer,
  };
  await acceptControlMessage(f.machine, f.from, input, signal);
  const first = loadLedger(f.machine).at(-1);
  expect(first?.communicationReceipt).toMatchObject({
    rootMessageId: input.messageId,
    sourceLetter: { body: f.letter.body },
  });
  let previous = input.messageId;
  for (let i = 0; i < 2; i++) {
    const communicationAuthorization = CommunicationAuthorizationInputSchema.parse({
      basis: 'thread-continuation',
      sourceMessageRef: `${f.to.threadId}#${previous}`,
    });
    const next = { ...input, messageId: crypto.randomUUID(), communicationAuthorization };
    await acceptControlMessage(f.machine, f.from, next, signal);
    expect((await acceptControlMessage(f.machine, f.from, next, signal)).duplicate).toBe(true);
    const recorded = loadLedger(f.machine).at(-1);
    expect(recorded?.communicationReceipt).toEqual(first?.communicationReceipt);
    expect(recorded?.communicationAuthorization).toEqual(communicationAuthorization);
    await expect(
      acceptControlMessage(
        f.machine,
        f.from,
        { ...next, messageId: crypto.randomUUID(), task: 'another' },
        signal,
      ),
    ).rejects.toThrow('different task');
    previous = next.messageId;
  }
  expect(loadLedger(f.machine)).toHaveLength(4);
  await expect(
    acceptControlMessage(
      f.machine,
      { ...f.from, machine: 'host-b' },
      { ...input, messageId: crypto.randomUUID() },
      signal,
    ),
  ).rejects.toThrow('originating host');
});

test('an outbound continuation inherits across a remote App endpoint without reading the remote host', () => {
  const f = fixture();
  const to = codexAppPeer('host-b', crypto.randomUUID(), 'remote');
  const receipt = requireOriginatingBasis(
    f.from,
    to,
    communicationAuthorization,
    () => null,
    'review',
  );
  const opened = buildEnvelope(f.from, to, 'request', {
    task: 'review',
    communicationAuthorization,
    communicationReceipt: receipt,
  });
  const claim = CommunicationAuthorizationInputSchema.parse({
    basis: 'thread-continuation',
    sourceMessageRef: `${to.threadId}#${opened.id}`,
  });
  const inherited = requireOriginatingBasis(
    f.from,
    to,
    claim,
    (id) => (id === opened.id ? opened : null),
    'review',
  );
  expect(inherited).toEqual(opened.communicationReceipt);
  expect(() =>
    requireOriginatingBasis(
      f.from,
      { ...to, threadId: crypto.randomUUID() },
      claim,
      () => opened,
      'review',
    ),
  ).toThrow('different recipient');
});

test('feed preserves source evidence or explicitly omits it whole without truncating a quote', () => {
  const f = fixture();
  const body = `${f.letter.body}${'界'.repeat(16000)}`;
  const receipt = resolveCommunicationBasis(f.from, f.to, 'review', f.peer, () => ({
    ...f.letter,
    body,
  }));
  const message = buildEnvelope(f.from, f.to, 'result', {
    task: 'review',
    communicationAuthorization: f.peer,
    communicationReceipt: receipt,
  });
  const row = rowFromLedgerRecord('host-a', message);
  expect(row.communicationReceipt?.sourceLetter?.body).toBe(body);
  const bounded = boundFrame({ kind: 'row', cursor: '2.1.0', row });
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  if (bounded.kind !== 'row') throw new Error('expected row');
  expect(bounded.row.communicationReceipt).toBeUndefined();
  expect(bounded.row.note).toContain('communication authorization omitted');
  expect(message.communicationReceipt?.sourceLetter?.body).toBe(body);
});
