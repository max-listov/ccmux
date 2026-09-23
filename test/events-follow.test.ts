import { afterAll, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventsPath } from '../src/config/paths.ts';
import { appendEvent, followEvents } from '../src/events/feed.ts';
import type { SessionEvent } from '../src/types.ts';
import { tailLines } from '../src/util/readLines.ts';
import { makeMachine, makeSession } from './helpers.ts';

// The feed's position is the file's SIZE, in bytes. A follower that cut decoded text at that
// position started every read one character later per multibyte character already in the file, so
// the first line of each read lost its head and was dropped as unparseable — and the first line of
// a read is usually the turn-end a consumer is waiting for.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccmux-follow-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('lines appended after multibyte text arrive whole', () => {
  const path = join(dir, 'feed.jsonl');
  writeFileSync(path, '{"detail":"сессия с кириллицей"}\n');
  const tail = tailLines(path, Buffer.byteLength('{"detail":"сессия с кириллицей"}\n'));
  appendFileSync(path, '{"n":1}\n{"detail":"ещё"}\n');
  expect(tail.read()).toEqual(['{"n":1}', '{"detail":"ещё"}']);
  appendFileSync(path, '{"n":2}\n');
  expect(tail.read()).toEqual(['{"n":2}']);
});

test('a character split by a write boundary is held until its remaining bytes arrive', () => {
  const path = join(dir, 'feed.jsonl');
  writeFileSync(path, '');
  const tail = tailLines(path, 0);
  const line = Buffer.from('{"detail":"ж"}\n');
  const cut = line.indexOf(Buffer.from('ж')) + 1; // inside the two bytes of 'ж'
  appendFileSync(path, line.subarray(0, cut));
  expect(tail.read()).toEqual([]);
  appendFileSync(path, line.subarray(cut));
  expect(tail.read()).toEqual(['{"detail":"ж"}']);
});

test('a file that shrank is read again from its start', () => {
  const path = join(dir, 'feed.jsonl');
  writeFileSync(path, '{"old":"старое"}\n{"old":2}\n');
  const tail = tailLines(path, 0);
  expect(tail.read()).toEqual(['{"old":"старое"}', '{"old":2}']);
  writeFileSync(path, '{"new":1}\n');
  expect(tail.read()).toEqual(['{"new":1}']);
});

test('follow delivers every appended event when the feed already holds multibyte text', async () => {
  const m = makeMachine({ rcPrefix: 'host-a', stateDir: dir });
  const s = makeSession({ name: 'agent-a' });
  appendEvent(m, s, { event: 'turn-end', detail: 'уже в журнале до подписки' });
  expect(Bun.file(eventsPath(m)).size).toBeGreaterThan(
    (await Bun.file(eventsPath(m)).text()).length,
  );

  const seen: SessionEvent[] = [];
  const controller = new AbortController();
  followEvents(m, (event) => seen.push(event), { signal: controller.signal });
  const written = [
    appendEvent(m, s, { event: 'turn-start', detail: 'кириллица' }),
    appendEvent(m, s, { event: 'turn-end' }),
    appendEvent(m, s, { event: 'turn-start' }),
    appendEvent(m, s, { event: 'turn-end', detail: 'снова' }),
  ].map((event) => event?.id ?? 'not written');

  const deadline = Date.now() + 10_000;
  while (seen.length < written.length && Date.now() < deadline) await Bun.sleep(20);
  controller.abort();
  expect(seen.map((event) => event.id)).toEqual(written);
});
