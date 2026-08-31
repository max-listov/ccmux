import { afterAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rowFromLedgerRecord } from '../src/chat/fleetLog.ts';
import {
  boundFrame,
  formatCursor,
  type LogFrame,
  LogFrameSchema,
  MAX_FRAME_BYTES,
  machineFrame,
  parseCursor,
  rowsAfter,
  ZERO_CURSOR,
} from '../src/chat/logFeed.ts';
import { unreadableReason } from '../src/commands/chat.ts';
import { chatLedgerPath, outboxPath } from '../src/config/paths.ts';
import { CHAT_GENERATION } from '../src/config/schema.ts';
import { makeMachine } from './helpers.ts';

// A snapshot answers "what is there now"; a live surface needs "what changed". Polling the first
// question makes every consumer re-serialise history it already has — and one message long enough to
// push that document past a transport's cap makes the JSON UNREADABLE rather than partly readable,
// because a cut document has no last brace. Bounded records cannot fail that way at all.

let dir: string;
const machine = () => makeMachine({ rcPrefix: 'host-a', stateDir: dir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccmux-logfeed-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function appendLedger(ts: string, body: string, id = randomUUID()): void {
  const path = chatLedgerPath(machine());
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({
      v: CHAT_GENERATION,
      id,
      ts,
      from: { kind: 'cli', source: 'ccmux', machine: 'host-a' },
      to: { kind: 'owner' },
      body,
      task: null,
      defer: false,
      onBehalfOf: null,
      notBefore: null,
    })}\n`,
  );
}

function appendOutbox(ts: string, body: string): void {
  const path = outboxPath(machine());
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({
      kind: 'msg',
      envelope: {
        v: CHAT_GENERATION,
        id: randomUUID(),
        ts,
        from: { kind: 'cli', source: 'ccmux', machine: 'host-a' },
        to: {
          kind: 'managed',
          source: 'ccmux',
          machine: 'host-b',
          agent: 'claude',
          session: 'agent-b',
          threadId: '11111111-1111-4111-8111-111111111111',
        },
        body,
        task: null,
        defer: false,
        onBehalfOf: null,
        notBefore: null,
      },
      result: { ok: true, detail: '' },
    })}\n`,
  );
}

const bodies = (frames: LogFrame[]): string[] =>
  frames.flatMap((f) => (f.kind === 'row' ? [f.row.body] : []));

// ── the cursor ───────────────────────────────────────────────────────────────────────────────────

test('a row appended while a consumer was away arrives after reconnect, exactly once', () => {
  // The whole point of a resumable feed, and the acceptance this was written for.
  appendLedger('2026-08-26T10:00:00.000Z', 'before');
  const first = rowsAfter(machine(), ZERO_CURSOR);
  expect(bodies(first.frames)).toEqual(['before']);

  appendLedger('2026-08-26T10:00:01.000Z', 'while away');
  const second = rowsAfter(machine(), first.cursor);
  expect(bodies(second.frames)).toEqual(['while away']);

  // …and reading again from the new cursor yields nothing, rather than the same row twice.
  expect(rowsAfter(machine(), second.cursor).frames).toEqual([]);
});

test('duplicate timestamps do not confuse the cursor — it counts records, not seconds', () => {
  // A time cursor cannot separate these: it either replays the ones it has or, silently, skips the
  // ones it has not. Positions are total and stable, so neither is possible.
  const same = '2026-08-26T10:00:00.000Z';
  appendLedger(same, 'first');
  appendLedger(same, 'second');
  appendLedger(same, 'third');
  const one = rowsAfter(machine(), ZERO_CURSOR);
  expect(bodies(one.frames)).toEqual(['first', 'second', 'third']);
  appendLedger(same, 'fourth');
  expect(bodies(rowsAfter(machine(), one.cursor).frames)).toEqual(['fourth']);
});

test('a clock that goes BACKWARDS loses nothing', () => {
  // A corrected clock, or a fleet whose machines disagree. Under a time cursor the later record
  // sorts behind one the consumer already has and is skipped forever; a position cannot regress.
  appendLedger('2026-08-26T10:00:05.000Z', 'later clock');
  const one = rowsAfter(machine(), ZERO_CURSOR);
  appendLedger('2026-08-26T09:59:00.000Z', 'clock stepped back');
  expect(bodies(rowsAfter(machine(), one.cursor).frames)).toEqual(['clock stepped back']);
});

test('both files advance independently, and neither resets the other', () => {
  appendLedger('2026-08-26T10:00:00.000Z', 'received');
  const one = rowsAfter(machine(), ZERO_CURSOR);
  appendOutbox('2026-08-26T10:00:01.000Z', 'sent');
  const two = rowsAfter(machine(), one.cursor);
  expect(bodies(two.frames)).toEqual(['sent']);
  expect(two.cursor).toMatchObject({ ledger: 1, outbox: 1 });
  appendLedger('2026-08-26T10:00:02.000Z', 'received again');
  expect(bodies(rowsAfter(machine(), two.cursor).frames)).toEqual(['received again']);
});

test('a cursor from another record generation is REFUSED, not reinterpreted', () => {
  // Positions are the one thing a generation change moves: the old file is retired to the archive,
  // and the same numbers now point into a different history. Reading them anyway is the quiet
  // failure — a consumer resuming into somebody else's log with no error to notice.
  const stale = parseCursor(`${CHAT_GENERATION - 1}.10.0`);
  expect('error' in stale).toBe(true);
  expect((stale as { error: string }).error).toContain('generation');
});

test('a malformed cursor is refused with what was expected', () => {
  expect(parseCursor('nonsense')).toMatchObject({
    error: expect.stringContaining('<generation>.<ledger>.<outbox>'),
  });
  expect(parseCursor('2.-1.0')).toMatchObject({ error: expect.stringContaining('non-negative') });
  expect(parseCursor('2.x.0')).toMatchObject({ error: expect.stringContaining('non-negative') });
});

test('a cursor survives the round trip it is meant for', () => {
  const round = parseCursor(formatCursor({ gen: CHAT_GENERATION, ledger: 145, outbox: 154 }));
  expect(round).toEqual({ cursor: { gen: CHAT_GENERATION, ledger: 145, outbox: 154 } });
});

// ── bounded records ──────────────────────────────────────────────────────────────────────────────

test('an oversized record is REPLACED with a named refusal, never cut', () => {
  // Cutting JSON is the failure this feed exists to remove: a truncated document is not partly
  // readable, and the reader learns nothing about why.
  const row = {
    ...rowFromLedgerRecord('host-a', null),
    machine: 'host-a',
    ts: '2026-08-26T10:00:00.000Z',
    kind: 'chat' as const,
    from: 'a',
    to: 'b',
    task: null,
    body: 'x'.repeat(MAX_FRAME_BYTES * 2),
    note: '',
  };
  const bounded = boundFrame({ kind: 'row', cursor: '2.1.0', row });
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  expect(bounded.kind).toBe('row');
  if (bounded.kind !== 'row') throw new Error('unreachable');
  expect(bounded.row.body).toContain('body omitted');
  expect(bounded.row.body).toContain(String(MAX_FRAME_BYTES * 2)); // the real size is named
  expect(bounded.row.note).toContain('oversized');
  // Everything that makes the record findable survives — route, time and position.
  expect(bounded.row.from).toBe('a');
  expect(bounded.cursor).toBe('2.1.0');
  // …and it is still a valid frame, so a strict consumer parses it like any other.
  expect(LogFrameSchema.safeParse(bounded).success).toBe(true);
});

test('the cap counts BYTES, so a long Unicode body is bounded by what the transport carries', () => {
  // Characters are not bytes: an emoji body a third the character count of an ASCII one can be the
  // same size on the wire, and a cap that counted characters would let it through.
  const emoji = '🙂'.repeat(MAX_FRAME_BYTES / 2); // 4 bytes each — well past the cap
  const row = {
    ...rowFromLedgerRecord('host-a', null),
    machine: 'host-a',
    ts: 't',
    kind: 'chat' as const,
    from: 'a',
    to: 'b',
    task: null,
    body: emoji,
    note: '',
  };
  const bounded = boundFrame({ kind: 'row', cursor: '2.1.0', row });
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  if (bounded.kind !== 'row') throw new Error('unreachable');
  expect(bounded.row.body).toContain('body omitted');
});

test('a long Unicode body that FITS is passed through untouched', () => {
  // The cap must not become a paraphraser. Bodies below it arrive exactly as written, accents and
  // all — this feed is the record of what was said.
  const body = 'ответ владельцу: релиз выпущен, всё раскатано 🚀';
  const row = {
    ...rowFromLedgerRecord('host-a', null),
    machine: 'host-a',
    ts: 't',
    kind: 'chat' as const,
    from: 'a',
    to: 'b',
    task: null,
    body,
    note: '',
  };
  const bounded = boundFrame({ kind: 'row', cursor: '2.1.0', row });
  if (bounded.kind !== 'row') throw new Error('unreachable');
  expect(bounded.row.body).toBe(body);
});

test('an oversized record still advances the stream — it keeps its position', () => {
  appendLedger('2026-08-26T10:00:00.000Z', 'y'.repeat(MAX_FRAME_BYTES * 2));
  appendLedger('2026-08-26T10:00:01.000Z', 'after the big one');
  const out = rowsAfter(machine(), ZERO_CURSOR);
  expect(bodies(out.frames)[1]).toBe('after the big one');
  expect(out.cursor.ledger).toBe(2);
  for (const f of out.frames)
    expect(Buffer.byteLength(JSON.stringify(f))).toBeLessThanOrEqual(MAX_FRAME_BYTES);
});

// ── the frame contract ───────────────────────────────────────────────────────────────────────────

test('one strict schema covers both frame kinds, and rejects an unknown key', () => {
  // A consumer branches on `kind`; an extra key here is a protocol error, not a courtesy.
  expect(LogFrameSchema.safeParse(machineFrame('host-a', ZERO_CURSOR)).success).toBe(true);
  expect(
    LogFrameSchema.safeParse({
      kind: 'machine',
      cursor: '2.0.0',
      machine: { machine: 'host-a', ok: true, error: null },
      extra: 1,
    }).success,
  ).toBe(false);
  expect(LogFrameSchema.safeParse({ kind: 'what', cursor: '2.0.0' }).success).toBe(false);
});

test('a machine frame says whether we could look, not only what we found', () => {
  // "Nothing happened there" and "we could not look" are different answers, and silence is the same
  // shape as both. A reader must be able to tell them apart without inferring it.
  const lost = machineFrame('host-b', ZERO_CURSOR, false, 'unreachable (no transit right now)');
  expect(lost).toMatchObject({ kind: 'machine', machine: { machine: 'host-b', ok: false } });
  if (lost.kind !== 'machine') throw new Error('unreachable');
  expect(lost.machine.error).toContain('unreachable');
  expect(LogFrameSchema.safeParse(lost).success).toBe(true);
});

test('a record this build cannot read becomes a row, not a gap', () => {
  // The position must not disappear: an append-only history that looks shorter than it is has
  // stopped being one.
  const path = chatLedgerPath(machine());
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({ v: 99, id: 'x', ts: 't', from: 'a', to: 'b', body: 'y' })}\n`,
  );
  appendLedger('2026-08-26T10:00:00.000Z', 'readable');
  const out = rowsAfter(machine(), ZERO_CURSOR);
  expect(out.cursor.ledger).toBe(2);
  expect(bodies(out.frames)[0]).toContain('cannot read');
  expect(bodies(out.frames)[1]).toBe('readable');
});

test('a line still being written is not emitted until its newline arrives', () => {
  // Both files are appended a line at a time, and a reader that took a half-written record would
  // emit a row that never existed — then never see the real one, because the position moved.
  const path = chatLedgerPath(machine());
  mkdirSync(dirname(path), { recursive: true });
  appendLedger('2026-08-26T10:00:00.000Z', 'complete');
  appendFileSync(path, '{"v":2,"id":"partial","ts":"2026');
  const out = rowsAfter(machine(), ZERO_CURSOR);
  expect(bodies(out.frames)).toEqual(['complete']);
  expect(out.cursor.ledger).toBe(1);
});

// ── the snapshot a peer answers with ─────────────────────────────────────────────────────────────

test('a CUT answer is named as cut, not blamed on an old build', () => {
  // The two produce the same JSON.parse failure and are nothing alike: one is fixed by asking for
  // less, the other by upgrading a machine. This snapshot serialises whole message bodies, so being
  // cut is the failure that actually happens — and "older ccmux?" sends the reader to the wrong
  // machine entirely.
  const cut = unreadableReason(
    '{"rows":[{"body":"aaa',
    '[wire] output truncated at the stream cap\n',
  );
  expect(cut).toContain("cut at the transport's cap");
  expect(cut).toContain('--follow');
  expect(cut).not.toContain('older ccmux');
});

test('a large answer with no closing brace betrays itself even with no marker', () => {
  // Not every transport says it cut something. A document that is both large and unterminated is
  // not an old build's output — old builds close their JSON.
  const reason = unreadableReason(`{"rows":[${'x'.repeat(70_000)}`, '');
  expect(reason).toContain('incomplete');
  expect(reason).not.toContain('older ccmux');
});

test('a small unparseable answer IS the old-build case, and still says so', () => {
  // The original diagnosis is right for the original cause; it just was not the only one.
  expect(unreadableReason('not json at all', '')).toContain('older ccmux');
});
