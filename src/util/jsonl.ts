import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Append-only JSON-lines files: one reader, one appender, one rotation.
 *
 * Seven stores kept their own copy of "read the file, split, parse, decide what a bad line means",
 * and the copies disagreed where it matters: the ledger threw on a line still being written, the
 * log reader called a read error "nothing yet", and the same file was counted in records by one
 * reader and in raw lines by another. Each store still decides what its records are and what a
 * damaged line means; how the file is read is decided here, once.
 *
 * A long-lived reader pays for new bytes only. The daemon read the whole ledger, the ack log and the
 * outbox on every three-second pass — tens of milliseconds on its event loop, repeated whether or not
 * anything had been written. A read remembers, per file, how far it has decoded and resumes there
 * while the file is the same file and has only grown; a file that was replaced or shrank is decoded
 * again from its first byte.
 */

/** What a line that is not JSON means: refuse the file, leave the line out, or hand `decode` the
 *  `UNREADABLE` marker so the line keeps its place as a hole. The last line of a file is never "bad":
 *  without its newline it is a record still being written, and it is read once it is whole. */
export type BadLine = 'throw' | 'skip' | 'hole';

/** What `decode` receives for a line that is not JSON, under the `hole` policy. */
export const UNREADABLE: unique symbol = Symbol('unreadable line');

export interface JsonlOptions<T> {
  /** Named in errors: `<label>:<line> — invalid JSON`. */
  label: string;
  badLine: BadLine;
  /** One parsed line to a record, or `undefined` to leave it out. May throw to refuse the file. */
  decode: (raw: unknown, line: number) => T | undefined;
}

interface Decoded {
  identity: string;
  /** Bytes decoded — always just past a newline. */
  offset: number;
  /** Lines consumed, blank ones included, so an error names the line a person would count to. */
  lines: number;
  records: unknown[];
  decode: unknown;
  /** The last bytes decoded. A resume re-reads them first: a file rewritten in place keeps its inode
   *  and can keep growing, and only its content says it is no longer the file that was decoded. */
  tail: Buffer;
}

/** How much of the decoded end a resume compares. */
const FINGERPRINT = 256;

function sameTail(fd: number, known: Decoded): boolean {
  const probe = Buffer.alloc(known.tail.length);
  const start = known.offset - known.tail.length;
  return readSync(fd, probe, 0, probe.length, start) === probe.length && probe.equals(known.tail);
}

const decoded = new Map<string, Decoded>();

/** Every record in the file, in order. A missing file has none. */
export function readJsonl<T>(path: string, options: JsonlOptions<T>): T[] {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      decoded.delete(path);
      return [];
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    const identity = `${stat.dev}:${stat.ino}`;
    const known = decoded.get(path);
    const resume =
      known !== undefined &&
      known.identity === identity &&
      known.decode === options.decode &&
      known.offset <= stat.size &&
      sameTail(fd, known);
    const base: Decoded = resume
      ? known
      : {
          identity,
          offset: 0,
          lines: 0,
          records: [],
          decode: options.decode,
          tail: Buffer.alloc(0),
        };
    if (base.offset === stat.size) return base.records.slice() as T[];
    const buffer = Buffer.alloc(stat.size - base.offset);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, base.offset + read);
      if (n === 0) break;
      read += n;
    }
    // Only whole lines: a newline byte never occurs inside a multi-byte character, so cutting at the
    // last one never splits a character either.
    const end = buffer.subarray(0, read).lastIndexOf(0x0a);
    if (end === -1) {
      decoded.set(path, base);
      return base.records.slice() as T[];
    }
    const added: unknown[] = [];
    const text = buffer.subarray(0, end).toString('utf8');
    let line = base.lines;
    for (const raw of text.split('\n')) {
      line++;
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        if (options.badLine === 'throw') throw new Error(`${options.label}:${line} — invalid JSON`);
        if (options.badLine === 'skip') continue;
        parsed = UNREADABLE;
      }
      const record = options.decode(parsed, line);
      // Shared by every later read of this file, so frozen: a caller that changed one in place would
      // otherwise change what the next reader is told the file says.
      if (record !== undefined)
        added.push(record !== null && typeof record === 'object' ? Object.freeze(record) : record);
    }
    // Committed only once every new line decoded: a refusal leaves the file to be read — and refused —
    // again, rather than half-remembered.
    const consumed = buffer.subarray(0, end + 1);
    const tail = Buffer.concat([
      base.tail,
      consumed.subarray(Math.max(0, consumed.length - FINGERPRINT)),
    ]);
    const next: Decoded = {
      identity,
      offset: base.offset + end + 1,
      lines: line,
      records: base.records.concat(added),
      decode: options.decode,
      tail: Buffer.from(tail.subarray(Math.max(0, tail.length - FINGERPRINT))),
    };
    decoded.set(path, next);
    return next.records.slice() as T[];
  } finally {
    closeSync(fd);
  }
}

/** Append one record as one line. A single `O_APPEND` write, so concurrent appenders never interleave
 *  within a line. Throws on failure; a store that must not fail its caller catches. */
export function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/**
 * Shift `path` → `.1` → … → `.keep` once it reaches `maxBytes`, dropping the oldest. Best-effort:
 * rotation must never cost the write that triggered it, so every failure is swallowed.
 */
export function rotateBySize(path: string, maxBytes: number, keep: number): void {
  try {
    if (statSync(path).size < maxBytes) return;
  } catch {
    return; // no file yet
  }
  try {
    rmSync(`${path}.${keep}`, { force: true });
    for (let generation = keep - 1; generation >= 1; generation--) {
      try {
        renameSync(`${path}.${generation}`, `${path}.${generation + 1}`);
      } catch {
        // that generation does not exist — fine
      }
    }
    renameSync(path, `${path}.1`);
  } catch {
    // never fail a write over housekeeping
  }
}
