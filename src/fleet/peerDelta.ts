import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from 'stitchkit/files';
import { z } from 'zod';
import { CACHE_DIR } from '../config/paths.ts';

/**
 * A peer's snapshot answer, carried by change.
 *
 * A fleet reader asks every peer for its session list and its chat log every few seconds, and
 * between two reads almost nothing changes: the same rows, one of them a step further. Sending the
 * whole answer each time made the fleet read the largest flow from the servers to the laptop,
 * roughly ten times what the reader keeps. So each row of a large array travels once: the reader
 * names the rows it already holds, and the peer sends a digest in place of any row the reader named.
 *
 * Content-addressed rather than versioned. A digest names a row's bytes, so the peer keeps no
 * memory of what it sent and the reader keeps no memory of an order: a row that changed has a new
 * digest and simply is not "held". A reader that lost its cache names nothing and gets everything.
 *
 * What changes on every read without anything happening — a running session's uptime — travels
 * beside the refs, never inside a digested row; otherwise every row would be new every second.
 */
export const PackedSchema = z
  .object({
    refs: z.array(z.string()),
    /** The rows the reader did not name, by digest. */
    items: z.record(z.string(), z.unknown()),
    /** Per ref, the part of the row that changes without an event. Absent for arrays that have none. */
    volatile: z.array(z.unknown()).optional(),
  })
  .strict();
export type Packed = z.infer<typeof PackedSchema>;

const DIGEST_HEX = 16;

export function rowDigest(row: unknown): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, DIGEST_HEX);
}

/** The `--known` value: the digests a reader holds, comma-joined. */
export function parseKnown(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').filter((digest) => digest !== ''));
}

export function pack<T>(
  rows: readonly T[],
  known: ReadonlySet<string>,
  split?: (row: T) => { stable: unknown; volatile: unknown },
): Packed {
  const refs: string[] = [];
  const items: Record<string, unknown> = {};
  const volatile: unknown[] = [];
  for (const row of rows) {
    const parts = split === undefined ? { stable: row, volatile: undefined } : split(row);
    const digest = rowDigest(parts.stable);
    refs.push(digest);
    volatile.push(parts.volatile);
    if (!known.has(digest)) items[digest] = parts.stable;
  }
  return split === undefined ? { refs, items } : { refs, items, volatile };
}

/**
 * The rows back, from the answer and what the reader holds; null when the answer names a row the
 * reader has neither received nor claimed to hold — a peer that broke the exchange, never a gap
 * to paper over.
 */
export function unpack(
  packed: Packed,
  held: Readonly<Record<string, unknown>>,
  join?: (stable: unknown, volatile: unknown) => unknown,
): unknown[] | null {
  const rows: unknown[] = [];
  for (const [index, digest] of packed.refs.entries()) {
    const stable = Object.hasOwn(packed.items, digest) ? packed.items[digest] : held[digest];
    if (stable === undefined) return null;
    rows.push(join === undefined ? stable : join(stable, packed.volatile?.[index]));
  }
  return rows;
}

/**
 * What this reader holds of one peer's answers of one kind.
 *
 * Loaded ONCE per read and used from memory: a concurrent reader may rewrite the file between the
 * request and the answer, and the rows this read claimed to hold must still be the ones it expands.
 */
export interface PeerHeld {
  rows: Record<string, unknown>;
  /** The `--known` argument, or nothing when the reader holds no row. */
  knownArgs: string[];
  /** Keeps exactly the rows the latest answer referenced. */
  save(packs: readonly Packed[]): void;
}

const HeldFileSchema = z.object({ rows: z.record(z.string(), z.unknown()) });

export function peerHeldDir(): string {
  return join(CACHE_DIR, 'peer-reads');
}

export function loadPeerHeld(machine: string, kind: 'list' | 'chat-log'): PeerHeld {
  const dir = peerHeldDir();
  const file = join(dir, `${machine}.${kind}.json`);
  let rows: Record<string, unknown> = {};
  try {
    if (existsSync(file))
      rows = HeldFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8'))).data?.rows ?? {};
  } catch {
    // A cache that cannot be read is a cache that holds nothing: the peer then sends every row.
  }
  const digests = Object.keys(rows);
  return {
    rows,
    knownArgs: digests.length === 0 ? [] : ['--known', digests.join(',')],
    save(packs) {
      const kept: Record<string, unknown> = {};
      for (const p of packs) {
        for (const digest of p.refs) {
          const row = Object.hasOwn(p.items, digest) ? p.items[digest] : rows[digest];
          if (row !== undefined) kept[digest] = row;
        }
      }
      try {
        mkdirSync(dir, { recursive: true });
        writeFileAtomicSync(file, JSON.stringify({ rows: kept }));
      } catch {
        // Not holding a row only costs the next read its size, never its correctness.
      }
    },
  };
}
