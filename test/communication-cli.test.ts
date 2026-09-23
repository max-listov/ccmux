import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireOriginatingBasis } from '../src/chat/communicationAuthorization.ts';
import { CommunicationAuthorizationInputSchema } from '../src/chat/communicationAuthorizationSchema.ts';
import { buildEnvelope } from '../src/chat/compose.ts';
import {
  cliPrincipal,
  externalTarget,
  managedPeer,
  servicePrincipal,
} from '../src/chat/identity.ts';
import { appendMessage, loadLedger } from '../src/chat/ledger.ts';
import { sessionsPath } from '../src/config/paths.ts';
import { appendOutboxAck } from '../src/fleet/flush.ts';
import { appendOutbound, loadOutbox } from '../src/fleet/outbox.ts';
import {
  communicationAuthorization,
  communicationAuthorizationFile,
} from './communication-fixture.ts';
import { makeChatMessage, makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync('/tmp/ccmux-communication-cli-');
  roots.push(root);
  const machine = makeMachine({
    stateDir: root,
    rcPrefix: 'host-a',
    chatEnabled: true,
    externals: { specialist: 'external conversation' },
  });
  const session = makeSession({ name: 'worker', dir: root, chat: true });
  const path = join(root, 'machine.json');
  writeFileSync(path, JSON.stringify(machine));
  writeFileSync(sessionsPath(machine), `${JSON.stringify(session)}\n`);
  const env: Record<string, string | undefined> = { ...process.env, CCMUX_CONFIG: path };
  delete env.CCMUX_SESSION;
  delete env.CCMUX_CHAT_CREDENTIAL;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  async function run(args: string[], envelope?: unknown, command: 'msg' | 'relay' = 'msg') {
    const file = envelope === undefined ? 'msg.ts' : 'receive-chat.ts';
    const invocation =
      command === 'relay'
        ? [join(import.meta.dir, '../src/cli.ts'), 'relay', ...args]
        : [join(import.meta.dir, 'fixtures', file), ...args];
    const child = Bun.spawn([process.execPath, '--no-env-file', ...invocation], {
      cwd: root,
      env,
      stdin: envelope === undefined ? 'ignore' : new Response(JSON.stringify(envelope)),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  return { machine, session, root, run };
}

test('local, role, exact App and fleet-prefixed addresses refuse before routing or queueing', async () => {
  const f = fixture();
  const uuid = crypto.randomUUID();
  for (const address of [
    'worker',
    'host-a:worker',
    '@worker',
    `app/${uuid}`,
    'host-b:worker',
    `host-b:app/${uuid}`,
  ]) {
    const result = await f.run([address, 'must not be sent']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--communication-authorization <JSON file> is required');
    expect(loadLedger(f.machine)).toEqual([]);
    expect(loadOutbox(f.machine)).toEqual([]);
  }
  const valid = await f.run([
    'host-a:worker',
    'allowed fixture',
    '--communication-authorization',
    communicationAuthorizationFile,
  ]);
  expect(valid.code).toBe(0);
  expect(loadLedger(f.machine)[0]).toMatchObject({
    body: 'allowed fixture',
    communicationAuthorization,
  });
  expect(valid.stdout).not.toContain(communicationAuthorization.userAuthorizationQuote);
});

test('malformed file and duplicate flags refuse without leaking quotes; owner and cancel are exempt', async () => {
  const f = fixture();
  const bad = join(f.root, 'bad.json');
  writeFileSync(bad, JSON.stringify({ ...communicationAuthorization, sourceMessageRef: '' }));
  const invalid = await f.run(['worker', 'text', '--communication-authorization', bad]);
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('invalid communication authorization');
  expect(invalid.stderr).not.toContain(communicationAuthorization.userAuthorizationQuote);
  const duplicate = await f.run([
    'worker',
    'text',
    '--communication-authorization',
    communicationAuthorizationFile,
    '--communication-authorization',
    communicationAuthorizationFile,
  ]);
  expect(duplicate.code).toBe(1);
  expect(loadLedger(f.machine)).toEqual([]);
  expect((await f.run(['owner', 'human notification'])).code).toBe(0);
  expect((await f.run(['cancel', 'sample-task'])).code).toBe(0);
});

test('relay to a session cannot bypass message admission', async () => {
  const f = fixture();
  appendMessage(
    f.machine,
    makeChatMessage({
      from: managedPeer('host-a', f.session),
      to: externalTarget('specialist'),
      task: 'relay-test',
      body: 'question',
    }),
  );
  const args = ['owner/specialist', '--task', 'relay-test', 'answer'];
  const refused = await f.run(args, undefined, 'relay');
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('--communication-authorization <JSON file> is required');
  expect(loadLedger(f.machine)).toHaveLength(1);
  expect(
    (
      await f.run(
        [...args, '--communication-authorization', communicationAuthorizationFile],
        undefined,
        'relay',
      )
    ).code,
  ).toBe(0);
  expect(loadLedger(f.machine)).toHaveLength(2);
  expect(loadLedger(f.machine)[1]).toMatchObject({ body: 'answer', communicationAuthorization });
});

test('authenticated remote receiver rejects missing evidence and self-attested human bypass', async () => {
  const f = fixture();
  const envelope = makeChatMessage({ to: managedPeer('host-a', f.session) });
  delete envelope.communicationAuthorization;
  expect((await f.run([], envelope)).code).toBe(1);
  const forged = {
    ...envelope,
    from: servicePrincipal('host-b', 'declared-service'),
    origin: {
      ingress: 'service',
      actor: 'human',
      assurance: 'application-attested',
      application: {
        applicationId: 'app',
        channelId: 'chat',
        actor: 'human',
        revision: '1',
        digest: 'a'.repeat(64),
      },
    },
  };
  const refused = await f.run([], forged);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('communicationAuthorization is required');
  expect(loadLedger(f.machine)).toEqual([]);
  const accepted = { ...envelope, communicationAuthorization };
  expect((await f.run([], accepted)).code).toBe(0);
  expect((await f.run([], accepted)).code).toBe(0);
  const conflict = await f.run([], {
    ...accepted,
    communicationAuthorization: {
      ...communicationAuthorization,
      sourceMessageRef: 'fixture://different',
    },
  });
  expect(conflict.code).toBe(1);
  expect(loadLedger(f.machine)).toHaveLength(1);
  expect(loadLedger(f.machine)[0]?.communicationAuthorization).toEqual(communicationAuthorization);
});

test('remote reception retains a resolved continuation and rejects an unresolved one', async () => {
  const f = fixture();
  const to = managedPeer('host-a', f.session);
  const from = managedPeer('host-b', makeSession({ uuid: crypto.randomUUID(), name: 'sender' }));
  const openingReceipt = requireOriginatingBasis(
    from,
    to,
    communicationAuthorization,
    () => null,
    'review',
  );
  const opening = buildEnvelope(from, to, 'opening', {
    communicationAuthorization,
    communicationReceipt: openingReceipt,
    task: 'review',
  });
  const claim = CommunicationAuthorizationInputSchema.parse({
    basis: 'thread-continuation',
    sourceMessageRef: `${to.threadId}#${opening.id}`,
  });
  const receipt = requireOriginatingBasis(
    from,
    to,
    claim,
    (id) => (id === opening.id ? { message: opening, reachedRecipient: true } : null),
    'review',
  );
  const message = buildEnvelope(from, to, 'continuation', {
    communicationAuthorization: claim,
    communicationReceipt: receipt,
    task: 'review',
  });
  const { communicationReceipt: omitted, ...unresolved } = message;
  expect((await f.run([], unresolved)).code).toBe(1);
  expect(loadLedger(f.machine)).toHaveLength(0);
  // The recipient does not need a local copy of the sender's prior outbound record.
  expect((await f.run([], message)).code).toBe(0);
  expect((await f.run([], message)).code).toBe(0);
  expect(loadLedger(f.machine)).toHaveLength(1);
  expect(loadLedger(f.machine)[0]?.communicationReceipt).toEqual(opening.communicationReceipt);
  const conflict = {
    ...message,
    communicationReceipt: { ...message.communicationReceipt, rootMessageId: crypto.randomUUID() },
  };
  expect((await f.run([], conflict)).code).toBe(1);
});

test('a successful send names its own letter, and that value is accepted verbatim as a continuation', async () => {
  const f = fixture();
  const opening = await f.run([
    'host-a:worker',
    'opening letter',
    '--task',
    'receipt-check',
    '--communication-authorization',
    communicationAuthorizationFile,
  ]);
  expect(opening.code).toBe(0);
  // The whole point is that the sender does not compose this: it copies one value out of its own
  // success. Parsing it here is the test standing in for that copy.
  const named = /^letter (\S+)/m.exec(opening.stdout);
  expect(named).not.toBeNull();
  const ref = named?.[1] ?? '';
  expect(ref).toBe(`${f.session.uuid}#${loadLedger(f.machine)[0]?.id}`);

  const continuation = join(f.root, 'continuation.json');
  writeFileSync(
    continuation,
    JSON.stringify({ basis: 'thread-continuation', sourceMessageRef: ref }),
  );
  const next = await f.run([
    'host-a:worker',
    'second letter',
    '--task',
    'receipt-check',
    '--communication-authorization',
    continuation,
  ]);
  expect(next.stderr).not.toContain('msg:');
  expect(next.code).toBe(0);
  const ledger = loadLedger(f.machine);
  expect(ledger).toHaveLength(2);
  expect(ledger[1]).toMatchObject({
    body: 'second letter',
    communicationAuthorization: { basis: 'thread-continuation', sourceMessageRef: ref },
    // The continuation inherits the opening receipt rather than opening a second one.
    communicationReceipt: { rootMessageId: ledger[0]?.id, sourceLetter: null },
  });

  // And it can be found again later, under the same reference, without reading another machine.
  const listed = await f.run(['sent', 'receipt-check']);
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain(ref);
  const asJson = await f.run(['sent', 'receipt-check', '--json']);
  const rows = JSON.parse(asJson.stdout).sent as { ref: string; id: string; task: string }[];
  expect(rows.map((row) => row.ref)).toContain(ref);
  expect(rows.every((row) => row.task === 'receipt-check')).toBe(true);
});

test('a fabricated reference is refused for having no record, not for being unreadable', async () => {
  const f = fixture();
  const invented = join(f.root, 'invented.json');
  const messageId = crypto.randomUUID();
  writeFileSync(
    invented,
    JSON.stringify({
      basis: 'thread-continuation',
      sourceMessageRef: `${f.session.uuid}#${messageId}`,
    }),
  );
  const refused = await f.run([
    'host-a:worker',
    'never sent',
    '--task',
    'receipt-check',
    '--communication-authorization',
    invented,
  ]);
  expect(refused.code).toBe(1);
  // The two refusals mean different things to the sender: "unreadable" says rewrite the reference,
  // "no record" says this letter does not exist. Swapping one vague reason for another would leave
  // the defect in place under a new message.
  expect(refused.stderr).toContain(
    `names message ${messageId}, of which this machine has no record`,
  );
  expect(refused.stderr).not.toContain('expected <peer thread uuid>');
  expect(loadLedger(f.machine)).toEqual([]);
});

test('a letter still held for retry is listed with its state and WITHOUT a reference', async () => {
  const f = fixture();
  const away = managedPeer('host-b', makeSession({ uuid: crypto.randomUUID(), name: 'peer' }));
  const envelope = buildEnvelope(cliPrincipal('host-a'), away, 'queued abroad', {
    task: 'held-check',
    communicationAuthorization,
    communicationReceipt: requireOriginatingBasis(
      cliPrincipal('host-a'),
      away,
      communicationAuthorization,
      () => null,
      'held-check',
    ),
  });
  appendOutbound(f.machine, {
    kind: 'msg',
    envelope,
    result: { ok: false, detail: 'transport failed' },
  });
  const held = JSON.parse((await f.run(['sent', 'held-check', '--json'])).stdout).sent as {
    ref: string | null;
    state: string;
    id: string;
  }[];
  expect(held).toHaveLength(1);
  expect(held[0]?.state).toBe('held');
  // The id is the sender's own record and stays visible; the REFERENCE is what a letter that never
  // reached the recipient's ledger must not hand out, because a continuation would then claim a
  // correspondence that was never opened.
  expect(held[0]?.id).toBe(envelope.id);
  expect(held[0]?.ref).toBeNull();
  const text = await f.run(['sent', 'held-check']);
  expect(text.stdout).toContain('held');
  expect(text.stdout).not.toContain(envelope.id);

  // CONTROL, the other direction: the same row once transit settles it. Nothing else changes.
  appendOutboxAck(f.machine, envelope.id);
  const delivered = JSON.parse((await f.run(['sent', 'held-check', '--json'])).stdout).sent as {
    ref: string | null;
    state: string;
  }[];
  expect(delivered[0]?.state).toBe('accepted');
  expect(delivered[0]?.ref).toBe(`${away.threadId}#${envelope.id}`);
});
