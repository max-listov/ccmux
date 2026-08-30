import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  courierNote,
  externalNameOf,
  isExternalToken,
  lookupExternal,
  outstandingExternal,
} from '../src/chat/external.ts';
import {
  chatTargetKey,
  externalAddress,
  externalTarget,
  humanTargetLabel,
  targetLabel,
} from '../src/chat/identity.ts';
import { formatForTg } from '../src/chat/telegram.ts';
import { CHAT_GENERATION, ChatMessageSchema, MachineConfigSchema } from '../src/config/schema.ts';
import type { ChatMessage, ChatPrincipal, ChatTarget } from '../src/types.ts';

// The route to a component owner outside the fleet is a PERSON, and that is the design: one hop
// through a human is cheaper than integrating with somebody else's product. What was missing is that
// the hop was unwritten — no record, no reply address, no way to ask what has not come back. And
// with nothing to address, people addressed the project instead, which is usually also a session
// name, so the message resolved, delivered, exited zero, and landed on a neighbour.

const machine = (externals: Record<string, string> = {}) =>
  MachineConfigSchema.parse({
    claudeBin: '/bin/claude',
    tmuxBin: '/bin/tmux',
    projectsDir: '/p',
    rcPrefix: 'host-a',
    stateDir: '/tmp/x',
    bootLabel: 'b',
    externals,
  });

const cli: ChatPrincipal = { kind: 'cli', source: 'ccmux', machine: 'host-a' };
const peer = (session: string): ChatPrincipal => ({
  kind: 'managed',
  source: 'ccmux',
  machine: 'host-a',
  agent: 'claude',
  session,
  threadId: '11111111-1111-4111-8111-111111111111',
});

function letter(
  to: ChatTarget,
  from: ChatPrincipal = cli,
  task: string | null = null,
  onBehalfOf: string | null = null,
  ts = '2026-08-25T10:00:00.000Z',
): ChatMessage {
  return ChatMessageSchema.parse({
    v: CHAT_GENERATION,
    id: randomUUID(),
    ts,
    from,
    to,
    body: 'text',
    task,
    defer: false,
    onBehalfOf,
    notBefore: null,
  });
}

test('the address says the route and cannot be a fleet address', () => {
  // No colon anywhere, so `<machine>:<session>` parsing can never see it — and the word `owner` is
  // already reserved for the human this party is reached through.
  expect(isExternalToken('owner/contract-owner')).toBe(true);
  expect(externalNameOf('owner/contract-owner')).toBe('contract-owner');
  expect(isExternalToken('host-a:agent-a')).toBe(false);
  expect(isExternalToken('owner')).toBe(false); // the human themself, not somebody beyond them
  expect(externalAddress('x')).toBe('owner/x');
});

test('an undeclared name is refused, not invented', () => {
  // The failure being removed is a message that went somewhere real and WRONG, so an address
  // resolving to nothing must stop rather than improvise.
  const out = lookupExternal(machine({ 'contract-owner': 'another product' }), 'owner/nobody');
  expect('error' in out).toBe(true);
  expect((out as { error: string }).error).toContain('declared here: owner/contract-owner');
});

test('with nothing declared, the refusal says how to declare it', () => {
  const out = lookupExternal(machine(), 'owner/contract-owner');
  expect((out as { error: string }).error).toContain('"externals"');
  expect((out as { error: string }).error).toContain('contract-owner');
});

test('a declared name resolves to where a person takes it', () => {
  const out = lookupExternal(
    machine({ 'contract-owner': 'another product, ping them there' }),
    'owner/contract-owner',
  );
  expect(out).toEqual({ name: 'contract-owner', where: 'another product, ping them there' });
});

test('the external target has its own key and label — it is not a session and not the owner', () => {
  const t = externalTarget('contract-owner');
  expect(chatTargetKey(t)).toBe('external:contract-owner');
  expect(chatTargetKey({ kind: 'owner' })).toBe('owner'); // still distinct
  expect(targetLabel(t)).toBe('owner/contract-owner');
  expect(humanTargetLabel(t)).toContain('relay this');
});

test('a letter sent outside the fleet is awaiting a reply BY DEFAULT', () => {
  // A flag the sender must remember is a flag that is wrong within a week. Waiting for an answer is
  // the norm here, not the exception, so the record itself is the question and closing it is the act.
  const ledger = [letter(externalTarget('contract-owner'))];
  expect(outstandingExternal(ledger).map((l) => l.name)).toEqual(['contract-owner']);
});

test('a recorded answer closes it, and only it', () => {
  const ledger = [
    letter(externalTarget('contract-owner'), peer('agent-a')),
    letter(
      {
        kind: 'managed',
        source: 'ccmux',
        machine: 'host-a',
        agent: 'claude',
        session: 'agent-a',
        threadId: '11111111-1111-4111-8111-111111111111',
      },
      cli,
      null,
      'owner/contract-owner',
    ),
  ];
  expect(outstandingExternal(ledger)).toEqual([]);
});

test('two letters want two answers — one reply must not close both', () => {
  // Counted rather than flagged. A set would let a single answer clear the whole correspondence with
  // that owner, under-reporting exactly what this list exists to show.
  const to = externalTarget('contract-owner');
  const back: ChatTarget = {
    kind: 'managed',
    source: 'ccmux',
    machine: 'host-a',
    agent: 'claude',
    session: 'agent-a',
    threadId: '11111111-1111-4111-8111-111111111111',
  };
  const ledger = [
    letter(to, peer('agent-a'), null, null, '2026-08-25T10:00:00.000Z'),
    letter(to, peer('agent-a'), null, null, '2026-08-25T11:00:00.000Z'),
    letter(back, cli, null, 'owner/contract-owner'),
  ];
  const waiting = outstandingExternal(ledger);
  expect(waiting.length).toBe(1);
  expect(waiting[0]?.msg.ts).toBe('2026-08-25T11:00:00.000Z'); // the older one was the one answered
});

test('answers are matched per task, so two errands do not answer each other', () => {
  const to = externalTarget('contract-owner');
  const back: ChatTarget = {
    kind: 'managed',
    source: 'ccmux',
    machine: 'host-a',
    agent: 'claude',
    session: 'agent-a',
    threadId: '11111111-1111-4111-8111-111111111111',
  };
  const ledger = [
    letter(to, peer('agent-a'), 'release'),
    letter(to, peer('agent-a'), 'schema'),
    letter(back, cli, 'release', 'owner/contract-owner'),
  ];
  expect(outstandingExternal(ledger).map((l) => l.msg.task)).toEqual(['schema']);
});

test('a record this build cannot read never becomes a phantom letter', () => {
  // The ledger keeps holes so cursors stay meaningful; nothing downstream may treat one as content.
  expect(outstandingExternal([null, letter(externalTarget('x'))]).length).toBe(1);
  expect(outstandingExternal([null, null])).toEqual([]);
});

test('what the courier is handed carries the route and the way back', () => {
  const note = courierNote('contract-owner', 'another product', 'please cut a release', 'release');
  expect(note).toContain('another product');
  expect(note).toContain('task: release');
  expect(note).toContain('please cut a release');
  // Without this line an answer has nowhere to be recorded, and the letter waits forever.
  expect(note).toContain('ccmux relay owner/contract-owner --task release "<their answer>"');
});

test('the mirror renders an errand, not a notification', () => {
  // The person reading it IS the transport. Rendering it like ordinary mail would leave them to
  // work that out.
  const tg = formatForTg(letter(externalTarget('contract-owner'), peer('agent-a')), {
    'contract-owner': 'another product',
  });
  expect(tg).toContain('outside the fleet');
  expect(tg).toContain('another product');
  expect(tg).toContain('ccmux relay owner/contract-owner');
});

test('an external letter with no recorded route still says so instead of pretending', () => {
  const tg = formatForTg(letter(externalTarget('contract-owner')), {});
  expect(tg).toContain('no route recorded on this machine');
});
