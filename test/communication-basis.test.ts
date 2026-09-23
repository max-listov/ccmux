import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_CREDENTIAL_ENV, rotateChatCredential } from '../src/chat/auth.ts';
import { CommunicationAuthorizationSchema } from '../src/chat/communicationAuthorizationSchema.ts';
import { resolveCommunicationBasis } from '../src/chat/communicationBasis.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { appendMessage, loadLedger } from '../src/chat/ledger.ts';
import { localMessageLookup } from '../src/chat/localMessages.ts';
import { ChatMessageSchema } from '../src/chat/messageSchema.ts';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';
import { chatAuthPath, sessionsPath } from '../src/config/paths.ts';
import { appendOutbound } from '../src/fleet/outbox.ts';
import { loadSessions } from '../src/session/registry.ts';
import type { ChatMessage, MachineConfig, Session } from '../src/types.ts';
import { makeSession } from './helpers.ts';

// The case this file exists for. A person gave two sessions leave to correspond and said it to ONE
// of them; the other holds no such line in its own conversation. Quoting a neighbour is prose, so
// the receipt could not be produced at all and the person had to repeat the words a second time,
// for the protocol. Referenced as a ccmux record the same permission is checkable — which is what
// every test below actually exercises.

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-basis-'));
  roots.push(dir);
  const cfg = {
    claudeBin: '/bin/claude',
    tmuxBin: '/bin/tmux',
    projectsDir: '/p',
    rcPrefix: 'host-a',
    stateDir: dir,
    bootLabel: 'b',
  };
  const cfgPath = join(dir, 'machine.json');
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const m = MachineConfigSchema.parse(cfg);
  const row = (name: string) =>
    JSON.stringify({ name, dir: '/tmp/x', uuid: randomUUID(), agent: 'claude', chatEnabled: true });
  writeFileSync(sessionsPath(m), `${row('alice')}\n${row('bob')}\n${row('carol')}\n`);
  for (const session of loadSessions(m)) rotateChatCredential(m, session);
  const named = (name: string): Session => {
    const session = loadSessions(m).find((item) => item.name === name);
    if (session === undefined) throw new Error(`no session ${name}`);
    return session;
  };
  return { dir, cfgPath, m, named };
}

function authorizationFile(dir: string, value: unknown): string {
  const path = join(dir, `authorization-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** A letter that ARRIVED here, exactly as the remote receive path records it. */
function arrival(m: MachineConfig, from: Session, to: Session, body: string): ChatMessage {
  const message = ChatMessageSchema.parse({
    v: 2,
    id: randomUUID(),
    ts: new Date().toISOString(),
    from: managedPeer(m.rcPrefix, from),
    to: managedPeer(m.rcPrefix, to),
    body,
    task: null,
    defer: true,
    onBehalfOf: null,
    notBefore: null,
  });
  appendMessage(m, message);
  return message;
}

async function runMsg(cfgPath: string, sender: string, args: string[]) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = cfgPath;
  env.CCMUX_SESSION = sender;
  const m = MachineConfigSchema.parse(JSON.parse(await Bun.file(cfgPath).text()));
  const session = loadSessions(m).find((item) => item.name === sender);
  if (session !== undefined)
    env[CHAT_CREDENTIAL_ENV] = (await Bun.file(chatAuthPath(m, session.name)).text()).trim();
  const proc = Bun.spawn(['bun', CLI, 'msg', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const RATIONALE =
  'Answer the neighbour that carried the permission, inside the work it named, and return the result there.';

test('a permission that arrived in a peer letter is produced as a reference, and the thread carries it', async () => {
  const f = setup();
  const bob = f.named('bob');
  const letter = arrival(f.m, bob, f.named('alice'), 'Max approved both ways, three letters each');

  const peerLetter = authorizationFile(f.dir, {
    basis: 'peer-letter',
    whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope: RATIONALE,
    userAuthorizationQuote: 'Max approved both ways, three letters each',
    sourceMessageRef: `${bob.uuid}#${letter.id}`,
  });
  const first = await runMsg(f.cfgPath, 'alice', [
    'bob',
    'taking it',
    '--communication-authorization',
    peerLetter,
  ]);
  expect(first.stderr).not.toContain('msg:');
  expect(first.code).toBe(0);
  const sent = loadLedger(f.m).at(-1);
  expect(sent?.communicationAuthorization).toMatchObject({
    basis: 'peer-letter',
    sourceMessageRef: `${bob.uuid}#${letter.id}`,
  });
  expect(sent?.communicationReceipt).toMatchObject({
    rootMessageId: sent?.id,
    sourceLetter: { id: letter.id, body: letter.body, from: letter.from, to: letter.to },
  });

  // The second and third letters of the same correspondence repeat nothing: they point at the
  // authorization already established, which is the only form a receipt can take and still be read
  // a month later.
  let previous = sent?.id ?? '';
  for (const body of ['first result', 'second result']) {
    const continuation = authorizationFile(f.dir, {
      basis: 'thread-continuation',
      sourceMessageRef: `${bob.uuid}#${previous}`,
    });
    const next = await runMsg(f.cfgPath, 'alice', [
      'bob',
      body,
      '--communication-authorization',
      continuation,
    ]);
    expect(next.stderr).not.toContain('msg:');
    expect(next.code).toBe(0);
    const record = loadLedger(f.m).at(-1);
    expect(record?.body).toBe(body);
    expect(record?.communicationReceipt).toEqual(sent?.communicationReceipt);
    expect(record?.communicationAuthorization).toEqual({
      basis: 'thread-continuation',
      sourceMessageRef: `${bob.uuid}#${previous}`,
    });
    previous = record?.id ?? '';
  }
});

test('a reference is refused when it does not say what the sender claims', async () => {
  const f = setup();
  const bob = f.named('bob');
  const carol = f.named('carol');
  // A real letter — addressed to someone else. An id alone proves nothing about who was given leave.
  const toCarol = arrival(f.m, bob, carol, 'Max approved both ways');
  const mine = arrival(f.m, f.named('alice'), carol, 'a letter of mine to a different recipient');
  const before = loadLedger(f.m).length;
  const cases: [string, unknown][] = [
    [
      'was addressed to',
      {
        basis: 'peer-letter',
        whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope: RATIONALE,
        userAuthorizationQuote: 'Max approved both ways',
        sourceMessageRef: `${bob.uuid}#${toCarol.id}`,
      },
    ],
    [
      'has no record',
      {
        basis: 'peer-letter',
        whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope: RATIONALE,
        userAuthorizationQuote: 'Max approved both ways',
        sourceMessageRef: `${bob.uuid}#${randomUUID()}`,
      },
    ],
    ['went to', { basis: 'thread-continuation', sourceMessageRef: `${bob.uuid}#${mine.id}` }],
    [
      'invalid communication authorization',
      {
        whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope: RATIONALE,
        userAuthorizationQuote: 'Max approved both ways',
        sourceMessageRef: 'chat://somewhere',
      },
    ],
  ];
  for (const [expected, value] of cases) {
    const result = await runMsg(f.cfgPath, 'alice', [
      'bob',
      'must not be sent',
      '--communication-authorization',
      authorizationFile(f.dir, value),
    ]);
    expect(result.stderr).toContain(expected);
    expect(result.code).toBe(1);
  }
  expect(loadLedger(f.m)).toHaveLength(before); // refused before anything was written
});

test('a continuation cannot inherit from a message that carries no authorization', async () => {
  const f = setup();
  const bob = f.named('bob');
  // Alice's own earlier letter to bob, recorded before the receipt existed: it has nothing to pass on.
  const unauthorized = arrival(f.m, f.named('alice'), bob, 'an older letter with no receipt');
  const result = await runMsg(f.cfgPath, 'alice', [
    'bob',
    'must not be sent',
    '--communication-authorization',
    authorizationFile(f.dir, {
      basis: 'thread-continuation',
      sourceMessageRef: `${bob.uuid}#${unauthorized.id}`,
    }),
  ]);
  expect(result.stderr).toContain('carries no authorization');
  expect(result.code).toBe(1);
});

test('a letter sent to another machine is found where it actually lives', () => {
  // Cross-machine mail is stored in the RECIPIENT's ledger; this machine keeps only the outbound
  // envelope. A lookup that read the ledger alone would answer "no record" for every letter we sent
  // abroad — which is exactly the half a continuation of a remote correspondence points at.
  const f = setup();
  const envelope = ChatMessageSchema.parse({
    v: 2,
    id: randomUUID(),
    ts: new Date().toISOString(),
    from: managedPeer(f.m.rcPrefix, f.named('alice')),
    to: { ...managedPeer(f.m.rcPrefix, f.named('bob')), machine: 'host-b' },
    body: 'sent abroad',
    task: null,
    defer: true,
    onBehalfOf: null,
    notBefore: null,
  });
  appendOutbound(f.m, { kind: 'msg', envelope, result: { ok: true, detail: '' } });
  expect(loadLedger(f.m).find((slot) => slot?.id === envelope.id)).toBeUndefined();
  expect(localMessageLookup(f.m)(envelope.id)?.message.body).toBe('sent abroad');
});

test('the refusal names all three bases, so the reader learns what would be accepted', async () => {
  const f = setup();
  const result = await runMsg(f.cfgPath, 'alice', ['bob', 'no file at all']);
  expect(result.code).toBe(1);
  for (const basis of ['user-instruction', 'peer-letter', 'thread-continuation'])
    expect(result.stderr).toContain(basis);
  expect(result.stderr).toContain('<peer thread uuid>#<message uuid>');
  expect(result.stderr).toContain('"basis": "user-instruction"');
  expect(result.stderr).toContain('"basis": "thread-continuation"');
  // The user-instruction reference is a pointer for the reader, and the help says so: an example
  // shaped like a record id sent agents searching a transcript for one that does not exist.
  expect(result.stderr).toContain(
    '"sourceMessageRef": "<your address> · user message <date time>"',
  );
  expect(result.stderr).toContain('Do not search a transcript for a message id');
});

test('a user-instruction reference in the documented prose form is accepted as before', () => {
  const sourceMessageRef = 'host-a:agent-a · user message 2026-09-15 13:31 +07:00';
  const authorization = CommunicationAuthorizationSchema.parse({
    basis: 'user-instruction',
    whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope:
      'Contact the designated reviewer to obtain the requested review result within scope.',
    userAuthorizationQuote: 'write to the reviewer',
    sourceMessageRef,
  });
  const receipt = resolveCommunicationBasis(
    managedPeer('host-a', makeSession({ name: 'agent-a' })),
    managedPeer('host-a', makeSession({ name: 'agent-b' })),
    null,
    authorization,
    () => null,
  );
  expect(receipt?.authorization.sourceMessageRef).toBe(sourceMessageRef);
});

test('a receipt written before the basis was named stays readable and claims nothing', () => {
  // The 13 records already in a live ledger. Absence is not the `user-instruction` basis: it is a
  // record that never stated one, and reading it as a stated basis would invent the fact.
  const legacy = CommunicationAuthorizationSchema.parse({
    whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope: RATIONALE,
    userAuthorizationQuote: 'the words as the user said them',
    sourceMessageRef: 'chat://conversation/1',
  });
  expect(legacy.basis).toBeUndefined();
  // And the shape a continuation drops is required of every basis that asserts one.
  for (const invalid of [
    { basis: 'peer-letter', sourceMessageRef: `${randomUUID()}#${randomUUID()}` },
    {
      basis: 'peer-letter',
      whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope: RATIONALE,
      userAuthorizationQuote: 'quoted',
      sourceMessageRef: 'not a ccmux record',
    },
    {
      basis: 'thread-continuation',
      userAuthorizationQuote: 'quoted again, which is exactly the ritual',
      sourceMessageRef: `${randomUUID()}#${randomUUID()}`,
    },
    { basis: 'thread-continuation', sourceMessageRef: `${randomUUID()}#not-a-uuid` },
  ])
    expect(CommunicationAuthorizationSchema.safeParse(invalid).success).toBe(false);
});

test('a continuation cannot be opened out of a letter that never reached its recipient', () => {
  // The looseness this closes: a letter this machine failed to deliver abroad still has an id, a
  // record and a complete receipt here, and every other check passes on it — so a correspondence
  // could be claimed from a letter nobody ever received.
  const f = setup();
  const from = managedPeer(f.m.rcPrefix, f.named('alice'));
  const away = { ...managedPeer(f.m.rcPrefix, f.named('bob')), machine: 'host-b' };
  const opening = ChatMessageSchema.parse({
    v: 2,
    id: randomUUID(),
    ts: new Date().toISOString(),
    from,
    to: away,
    body: 'never arrived',
    task: 'held',
    defer: true,
    onBehalfOf: null,
    notBefore: null,
    communicationAuthorization: {
      basis: 'user-instruction',
      whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope:
        'Contact this isolated test recipient to exercise the requested message admission behavior.',
      userAuthorizationQuote: 'Send the fixture message to the isolated test recipient.',
      sourceMessageRef: 'fixture://user/message-1',
    },
    communicationReceipt: {
      rootMessageId: randomUUID(),
      authorization: {
        basis: 'user-instruction',
        whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope:
          'Contact this isolated test recipient to exercise the requested message admission behavior.',
        userAuthorizationQuote: 'Send the fixture message to the isolated test recipient.',
        sourceMessageRef: 'fixture://user/message-1',
      },
      sourceLetter: null,
    },
  });
  const claim = CommunicationAuthorizationSchema.parse({
    basis: 'thread-continuation',
    sourceMessageRef: `${away.threadId}#${opening.id}`,
  });
  appendOutbound(f.m, {
    kind: 'msg',
    envelope: opening,
    result: { ok: false, detail: 'transport failed' },
  });
  expect(() =>
    resolveCommunicationBasis(from, away, 'held', claim, localMessageLookup(f.m)),
  ).toThrow('never reached its recipient');

  // CONTROL, the other direction: the identical reference on a letter transit did settle. Nothing
  // else about the claim changes, so the refusal above is about delivery and nothing else.
  appendOutbound(f.m, { kind: 'msg', envelope: opening, result: { ok: true, detail: '' } });
  expect(
    resolveCommunicationBasis(from, away, 'held', claim, localMessageLookup(f.m)),
  ).toMatchObject({ sourceLetter: null });
});
