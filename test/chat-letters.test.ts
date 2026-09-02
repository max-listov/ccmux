import { expect, test } from 'bun:test';
import { rowFromLedgerRecord } from '../src/chat/fleetLog.ts';
import { letterCounts, NO_LETTERS } from '../src/chat/letters.ts';
import type { ChatMessage } from '../src/types.ts';

const peer = (machine: string, session: string) =>
  ({
    kind: 'managed',
    source: 'ccmux',
    machine,
    agent: 'claude',
    session,
    threadId: `00000000-0000-4000-8000-${session.padStart(12, '0')}`,
  }) as const;

const letter = (from: ChatMessage['from'], to: ChatMessage['to'], ts: string): ChatMessage => ({
  v: 2,
  id: crypto.randomUUID(),
  ts,
  from,
  to,
  body: 'text',
  task: null,
  defer: true,
  onBehalfOf: null,
  notBefore: null,
});

const rows = (messages: ChatMessage[]) =>
  messages.map((message) => rowFromLedgerRecord('host-a', message));

test('a letter is counted for its sender and for its recipient', () => {
  const counts = letterCounts(
    rows([
      letter(peer('host-a', 'agent-a'), peer('host-a', 'agent-b'), '2026-09-02T10:00:00.000Z'),
      letter(peer('host-a', 'agent-b'), peer('host-a', 'agent-a'), '2026-09-02T10:05:00.000Z'),
      letter(peer('host-a', 'agent-b'), peer('host-a', 'agent-c'), '2026-09-02T10:09:00.000Z'),
    ]),
    'host-a',
  );
  expect(counts.get('agent-a')).toEqual({ total: 2, lastAt: '2026-09-02T10:05:00.000Z' });
  expect(counts.get('agent-b')).toEqual({ total: 3, lastAt: '2026-09-02T10:09:00.000Z' });
  expect(counts.get('agent-c')).toEqual({ total: 1, lastAt: '2026-09-02T10:09:00.000Z' });
});

test('a session writing to itself has exchanged one letter, not two', () => {
  // A router's own watchdog is exactly this: `msg <self> --after N`. Counting the send and the
  // receipt separately would double every timer a router sets.
  const self = peer('host-a', 'agent-a');
  const counts = letterCounts(rows([letter(self, self, '2026-09-02T10:00:00.000Z')]), 'host-a');
  expect(counts.get('agent-a')).toEqual({ total: 1, lastAt: '2026-09-02T10:00:00.000Z' });
});

test("another machine's sessions are not counted into this one", () => {
  // The count belongs to the machine where the session lives and holds its whole record. A peer
  // name that happens to match one of ours must not add to it.
  const counts = letterCounts(
    rows([
      letter(peer('host-b', 'agent-a'), peer('host-b', 'agent-b'), '2026-09-02T10:00:00.000Z'),
      letter(peer('host-a', 'agent-a'), peer('host-b', 'agent-b'), '2026-09-02T10:01:00.000Z'),
    ]),
    'host-a',
  );
  expect(counts.get('agent-a')).toEqual({ total: 1, lastAt: '2026-09-02T10:01:00.000Z' });
  expect(counts.has('agent-b')).toBe(false);
});

test('a session with no letters reports none, which is not the absence of an answer', () => {
  const counts = letterCounts([], 'host-a');
  expect(counts.get('agent-a')).toBeUndefined();
  // The row falls back to this rather than to null: "none" is about the conversation, null is about
  // the build that answered, and a consumer must be able to tell them apart.
  expect(NO_LETTERS).toEqual({ total: 0, lastAt: null });
});

test("a party that is not one of this machine's sessions contributes nothing", () => {
  // Three parties and one non-party arrive as null here: the owner, the command line, a session on
  // another machine, and a record this build cannot read — which still becomes a row, with no
  // sender, no target and an empty timestamp. Attributing a letter to any of them would put an
  // empty string into `lastAt`, which sorts before every real instant.
  const counts = letterCounts(
    [
      rowFromLedgerRecord('host-a', null),
      ...rows([
        letter(peer('host-a', 'agent-a'), peer('host-a', 'agent-b'), '2026-09-02T10:00:00.000Z'),
      ]),
    ],
    'host-a',
  );
  // The WHOLE map, not one key: a null party counted under some placeholder name would leave the
  // asked-for key correct and add an entry nobody would look at.
  expect([...counts.entries()]).toEqual([
    ['agent-a', { total: 1, lastAt: '2026-09-02T10:00:00.000Z' }],
    ['agent-b', { total: 1, lastAt: '2026-09-02T10:00:00.000Z' }],
  ]);
});
