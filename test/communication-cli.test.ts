import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
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
import { REMOTE_HOP_MS } from '../src/chat/letterParties.ts';
import { LetterRequestSchema } from '../src/chat/letterRequestSchema.ts';
import { sendLetter } from '../src/chat/sendLetter.ts';
import { SendReceiptSchema, SentListSchema } from '../src/chat/sentLetterSchema.ts';
import { sessionsPath } from '../src/config/paths.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import {
  appendOutboxAck,
  loadOutboxAcked,
  loadOutboxSettled,
  retryCandidates,
} from '../src/fleet/flush.ts';
import { appendOutbound, loadOutbox } from '../src/fleet/outbox.ts';
import type { runPeer } from '../src/fleet/transport.ts';
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
  delete env.CODEX_APP_TOOLS_PIPE_PATH;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
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

test('a program that sends a letter is answered with one line: the receipt of that letter', async () => {
  const f = fixture();
  const authorized = ['--communication-authorization', communicationAuthorizationFile];
  const receiptSchema = z.fromJSONSchema(
    (JSON.parse((await f.run(['--schema'])).stdout) as { receipt: never }).receipt,
  );
  const send = async (args: string[]) => {
    const result = await f.run([...args, '--json']);
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    // Exactly one line, and it is the receipt: nothing a person would be told is mixed into it.
    expect({ lines: lines.length, said: result.stderr }).toMatchObject({ lines: 1 });
    const receipt = SendReceiptSchema.parse(JSON.parse(lines[0] as string));
    expect(receiptSchema.safeParse(receipt).success).toBe(true);
    return { ...result, receipt };
  };

  const accepted = await send([
    'host-a:worker',
    'the heron plan',
    '--task',
    'heron',
    ...authorized,
  ]);
  expect(accepted.code).toBe(0);
  const inLedger = loadLedger(f.machine)[0];
  expect(accepted.receipt).toMatchObject({
    state: 'accepted',
    id: inLedger?.id,
    to: `ccmux/claude@host-a:worker#${inLedger?.to.kind === 'managed' ? inLedger.to.threadId : ''}`,
    task: 'heron',
    notBefore: null,
    note: null,
    preview: 'the heron plan',
  });
  expect(accepted.receipt.ref).toContain(inLedger?.id as string);
  // The same letter, in the same shape, when the sender looks back.
  const listed = SentListSchema.parse(JSON.parse((await f.run(['sent', '--json'])).stdout));
  const { from: _from, notBefore: _notBefore, note: _note, ...letter } = accepted.receipt;
  expect(listed.sent).toEqual([letter]);

  // Somewhere ccmux does not deliver: recorded, never reported as delivered, and no reference.
  const recorded = await send(['owner/specialist', 'carry this']);
  expect(recorded.receipt).toMatchObject({ state: 'recorded', ref: null });
  expect(recorded.receipt.note).toContain('ccmux does not deliver there');
  expect((await send(['owner', 'for you'])).receipt).toMatchObject({
    state: 'accepted',
    ref: null,
  });

  // A machine that cannot be asked who the recipient is: nothing is recorded, so there is no
  // receipt — the name cannot resolve, the hop fails at once and nothing is contacted.
  writeFileSync(
    join(f.root, 'machine.json'),
    JSON.stringify({ ...f.machine, fleet: { 'host-b': 'host-b.invalid' } }),
  );
  const unreachable = await f.run(['host-b:worker', 'later', '--json', ...authorized]);
  expect([unreachable.code, unreachable.stdout]).toEqual([1, '']);
  expect(unreachable.stderr).toContain('transport failed');
  expect(loadOutbox(f.machine)).toEqual([]);

  // A refusal is not a receipt, and the other verbs do not pretend to have one.
  const refused = await f.run(['host-a:nobody', 'text', '--json', ...authorized]);
  expect([refused.code, refused.stdout]).toEqual([1, '']);
  expect((await f.run(['pending', '--json'])).stderr).toContain("--json answers a send and 'sent'");
  // A person is still told in sentences.
  const person = await f.run(['host-a:worker', 'plain', ...authorized]);
  expect(person.stdout).toContain('sent ');
  expect(person.stdout).toContain('letter ');
});

test('a letter refused for good is listed as refused, is not retried and offers no reference', async () => {
  const f = fixture();
  const away = managedPeer('host-b', makeSession({ uuid: crypto.randomUUID(), name: 'peer' }));
  const envelope = buildEnvelope(cliPrincipal('host-a'), away, 'never welcome', {
    task: 'refused-check',
    communicationAuthorization,
    communicationReceipt: requireOriginatingBasis(
      cliPrincipal('host-a'),
      away,
      communicationAuthorization,
      () => null,
      'refused-check',
    ),
  });
  appendOutbound(f.machine, {
    kind: 'msg',
    envelope,
    result: { ok: false, detail: 'transport failed' },
  });
  const listed = async () =>
    SentListSchema.parse(JSON.parse((await f.run(['sent', 'refused-check', '--json'])).stdout))
      .sent[0];
  const pending = () =>
    retryCandidates(loadOutbox(f.machine), loadOutboxSettled(f.machine), Date.now()).length;
  expect([(await listed())?.state, pending()]).toEqual(['held', 1]);
  // The far side said no for good: settled, so nothing more is tried — and it was not delivered,
  // so the look back does not call it accepted or hand out a reference to continue it by.
  appendOutboxAck(f.machine, envelope.id, 'refused');
  expect(await listed()).toMatchObject({ state: 'refused', ref: null, id: envelope.id });
  expect(pending()).toBe(0);
  expect(loadOutboxAcked(f.machine).has(envelope.id)).toBe(false);
  // A delivery recorded for the same letter is a delivery, whatever was said before it.
  appendOutboxAck(f.machine, envelope.id);
  expect((await listed())?.state).toBe('accepted');
  expect((await listed())?.ref).toContain(envelope.id);
});

test('with no question, a session is told about itself', async () => {
  const f = fixture();
  const ask = async (env: Record<string, string>) => {
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        join(import.meta.dir, '../src/cli.ts'),
        'whois',
        '--json',
      ],
      {
        cwd: f.root,
        env: { ...process.env, CCMUX_CONFIG: join(f.root, 'machine.json'), ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const self = await ask({ CCMUX_SESSION: 'worker' });
  expect(self.code).toBe(0);
  expect(JSON.parse(self.stdout)).toMatchObject({
    found: 'session',
    by: 'address',
    session: { address: 'host-a:worker', dir: f.root },
    // Itself is on this machine: nobody else is asked.
    machines: [{ machine: 'host-a', status: 'asked' }],
  });
  // Outside a session there is nobody to be told about.
  const { CCMUX_SESSION: _session, ...outside } = process.env;
  const child = Bun.spawnSync(
    [process.execPath, '--no-env-file', join(import.meta.dir, '../src/cli.ts'), 'whois'],
    { cwd: f.root, env: { ...outside, CCMUX_CONFIG: join(f.root, 'machine.json') } },
  );
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain('ask about one thing');
});

test('a letter sent through the client is answered with the receipt ccmux msg --json prints', async () => {
  const f = fixture();
  const before = process.env.CCMUX_CONFIG;
  process.env.CCMUX_CONFIG = join(f.root, 'machine.json');
  const publisher = new ControlPublisher(f.machine);
  const server = createControlServer(f.machine, publisher);
  const client = createControlClient({ socket: controlSocket(f.machine) });
  try {
    const request = {
      to: 'host-a:worker',
      body: 'the kestrel plan',
      task: 'kestrel',
      communicationAuthorization,
    };
    const byClient = await client['letter.send'](request);
    const byCommand = SendReceiptSchema.parse(
      JSON.parse(
        (
          await f.run([
            request.to,
            request.body,
            '--task',
            request.task,
            '--communication-authorization',
            communicationAuthorizationFile,
            '--json',
          ])
        ).stdout,
      ),
    );
    // Two letters, so two ids, two references and two times. And two senders, each named as what
    // it is: a program on the control socket is this machine's service, the command its command
    // line — an agent's session is the same managed sender on both roads. Every other field is
    // the same.
    const same = ({ id: _id, ref: _ref, ts: _ts, from: _from, ...rest }: typeof byClient) => rest;
    expect(same(byClient)).toEqual(same(byCommand));
    expect([byClient.from, byCommand.from]).toEqual(['ccmux/service@host-a', 'ccmux/cli@host-a']);
    expect(byClient).toMatchObject({ state: 'accepted', task: 'kestrel', note: null });
    expect(loadLedger(f.machine).map((row) => row?.id)).toEqual([byClient.id, byCommand.id]);

    // A letter that cannot be sent is refused with the sentence the command says, and not written.
    await expect(
      client['letter.send']({ to: 'nobody', body: 'hello', communicationAuthorization }),
    ).rejects.toMatchObject({
      code: 'LETTER_REFUSED',
      message: "msg: no such session 'nobody'",
    });
    expect(
      (
        await f.run([
          'nobody',
          'hello',
          '--communication-authorization',
          communicationAuthorizationFile,
        ])
      ).stderr,
    ).toContain("msg: no such session 'nobody'");
    expect(loadLedger(f.machine)).toHaveLength(2);
  } finally {
    await client.close();
    publisher.close();
    await server.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await server.observability.close();
    if (before === undefined) delete process.env.CCMUX_CONFIG;
    else process.env.CCMUX_CONFIG = before;
  }
});

test("a letter to another machine spends the caller's time, not twenty seconds a hop", async () => {
  const root = mkdtempSync('/tmp/ccmux-letter-budget-');
  roots.push(root);
  const machine = makeMachine({ stateDir: root, rcPrefix: 'host-a', fleet: { 'host-b': 'b' } });
  const asked: number[] = [];
  const run: typeof runPeer = async (_m, _machine, _alias, _argv, opts) => {
    asked.push(opts?.timeoutMs ?? -1);
    return {
      code: 1,
      stdout: '',
      stderr: '',
      transportFailed: true,
      delivery: 'not-sent',
      failureDetail: 'test: not reachable',
    };
  };
  const request = LetterRequestSchema.parse({
    to: 'host-b:worker',
    body: 'the kestrel plan',
    communicationAuthorization,
  });
  const from = cliPrincipal('host-a');
  await sendLetter(machine, from, request, { run, deadline: Date.now() + 5_000 });
  // A command line has no deadline: each hop has its own.
  await sendLetter(machine, from, request, { run });
  expect(asked).toHaveLength(2);
  expect(asked[0]).toBeLessThanOrEqual(5_000);
  expect(asked[0]).toBeGreaterThan(4_000);
  expect(asked[1]).toBe(REMOTE_HOP_MS);
});
