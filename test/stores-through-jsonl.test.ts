import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The append-only stores are read and appended through `src/util/jsonl.ts`, and only there.
 *
 * Seven copies of "read, split, parse, decide what a bad line means" disagreed in the ways that
 * matter — one threw on a line still being written, one called a read error "nothing yet". A new
 * copy would be written the same way the old ones were, by someone who needed the records and did
 * not look for the reader; this is what notices.
 */
const STORE_PATHS = ['chatLedgerPath', 'chatAckPath', 'outboxPath', 'outboxAckPath', 'eventsPath'];

test('no module reads or appends a chat store or the event feed by hand', () => {
  const root = join(import.meta.dir, '..', 'src');
  const offenders: string[] = [];
  for (const file of new Bun.Glob('**/*.ts').scanSync(root)) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const fn of STORE_PATHS) {
      // A path handed straight to a raw read or append, or kept in a variable that is.
      const direct = new RegExp(`(readFileSync|appendFileSync)\\(\\s*${fn}\\(`);
      if (direct.test(text)) offenders.push(`${file}: ${fn} read or appended directly`);
    }
    if (
      /readFileSync\([^)]*(ledger|outbox|ack|events)[^)]*\)[^;]*split\(/i.test(text) &&
      !file.endsWith('util/jsonl.ts')
    )
      offenders.push(`${file}: splits a store file by hand`);
  }
  expect(offenders).toEqual([]);
});
