import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireOriginatingBasis } from '../src/chat/communicationAuthorization.ts';
import { CommunicationAuthorizationInputSchema } from '../src/chat/communicationAuthorizationSchema.ts';
import { buildEnvelope } from '../src/chat/compose.ts';
import { externalTarget, managedPeer, servicePrincipal } from '../src/chat/identity.ts';
import { appendMessage, loadLedger } from '../src/chat/store.ts';
import { sessionsPath } from '../src/config/paths.ts';
import { loadOutbox } from '../src/fleet/outbox.ts';
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
    (id) => (id === opening.id ? opening : null),
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
