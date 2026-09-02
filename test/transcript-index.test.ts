import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKPOINT_LINES,
  EMPTY_STATS,
  indexTranscript,
  SCAN_CHUNK,
} from '../src/agent/transcriptIndex.ts';

/**
 * Every read here must give exactly what a full read of the same file would.
 *
 * That is the only thing worth asserting: the index exists to answer the same question faster, and
 * an index that answers a different question is worse than the full pass it replaced — it is wrong
 * on the part of the conversation nobody happened to be looking at.
 */
const withFile = <T>(lines: string[], run: (path: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-index-'));
  try {
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Counting nothing: this suite is about lines and offsets, and the parser is somebody else's. */
const noStats = () => ({ ...EMPTY_STATS });

const numbered = (count: number) =>
  Array.from({ length: count }, (_, i) => JSON.stringify({ n: i + 1 }));

test('a window comes back with the absolute line numbers a cursor is expressed in', () => {
  const lines = numbered(2_000);
  withFile(lines, (path) => {
    const index = indexTranscript(path, 'claude', noStats);
    expect(index?.totalLines).toBe(2_000);
    // Across a checkpoint boundary, which is where an off-by-one would hide: the block containing
    // line 1_500 starts at a checkpoint, and the window must not begin at the block's first line.
    expect(index?.read(1_500, 1_502)).toEqual(lines.slice(1_499, 1_502));
    expect(index?.read(1, 3)).toEqual(lines.slice(0, 3));
    expect(index?.read(1_881, 2_000)).toEqual(lines.slice(1_880));
    // Exactly on the boundaries, both sides.
    expect(index?.read(CHECKPOINT_LINES, CHECKPOINT_LINES + 1)).toEqual(
      lines.slice(CHECKPOINT_LINES - 1, CHECKPOINT_LINES + 1),
    );
    // Out of range asks answer with what exists, not with a throw or a wrong slice.
    expect(index?.read(2_001, 2_100)).toEqual([]);
    expect(index?.read(1_999, 5_000)).toEqual(lines.slice(1_998));
  });
});

test('a record larger than any read chunk comes back whole', () => {
  // The negative control the old tail reader needed a byte ladder for: a single record bigger than
  // the window budget came back empty there. Here the record is bounded by checkpoints, not bytes.
  const huge = JSON.stringify({ text: 'x'.repeat(700 * 1024) });
  const lines = [...numbered(10), huge, ...numbered(5)];
  withFile(lines, (path) => {
    const index = indexTranscript(path, 'claude', noStats);
    expect(index?.totalLines).toBe(16);
    expect(index?.read(11, 11)[0]).toBe(huge);
    expect(index?.read(1, 16)).toEqual(lines);
  });
});

test('a multi-byte character split across a scan boundary reaches the parser intact', () => {
  // Placed deliberately: the three bytes of ≈ straddle the offset where one read ends and the next
  // begins. Nothing else in the file looks wrong, so this is a fixture rather than a hope.
  //
  // Asserted on what the SCAN hands the parser, not on what `read` returns — `read` decodes its own
  // window in one go and cannot show this. The damage lands on the stats: a line the parser cannot
  // JSON.parse is a line counted as nothing, and the total is quietly one short forever, because
  // the index never scans those bytes again.
  const filler = 'a'.repeat(SCAN_CHUNK - 2);
  const straddling = `${filler}≈tail`;
  withFile([straddling, JSON.stringify({ n: 'after' })], (path) => {
    const scanned: string[] = [];
    const index = indexTranscript(path, 'claude', (batch) => {
      scanned.push(...batch);
      return { ...EMPTY_STATS };
    });
    expect(index?.totalLines).toBe(2);
    expect(scanned).toEqual([straddling, JSON.stringify({ n: 'after' })]);
    expect(scanned.join('')).not.toContain('\uFFFD');
    // And the window read is the same text, which is a different path over the same bytes.
    expect(index?.read(1, 1)[0]).toBe(straddling);
  });
}, 30_000);

test('appended lines cost only the append, and the totals move with them', () => {
  const lines = numbered(600);
  withFile(lines, (path) => {
    const seen: number[] = [];
    const counting = (batch: string[]) => {
      seen.push(batch.length);
      return { ...EMPTY_STATS, messages: batch.length };
    };
    expect(indexTranscript(path, 'claude', counting)?.stats.messages).toBe(600);
    expect(seen).toEqual([600]);

    appendFileSync(path, `${JSON.stringify({ n: 601 })}\n`);
    seen.length = 0;
    const grown = indexTranscript(path, 'claude', counting);
    // One line parsed, not six hundred and one — this is the whole point, and a full rescan would
    // still produce the right total while costing exactly what it was built to avoid.
    expect(seen).toEqual([1]);
    expect(grown?.totalLines).toBe(601);
    expect(grown?.stats.messages).toBe(601);
    expect(grown?.read(601, 601)).toEqual([JSON.stringify({ n: 601 })]);
  });
});

test('a record still being written is outside the index until its newline arrives', () => {
  const lines = numbered(5);
  withFile(lines, (path) => {
    appendFileSync(path, '{"n":6,"half":');
    const index = indexTranscript(path, 'claude', noStats);
    // Five, not six: a fragment is not a line, and checkpointing it would put an offset in the
    // middle of a record that is about to grow.
    expect(index?.totalLines).toBe(5);
    appendFileSync(path, '"written"}\n');
    expect(indexTranscript(path, 'claude', noStats)?.totalLines).toBe(6);
  });
});

test('a file that was replaced rather than appended to is indexed again', () => {
  const lines = numbered(600);
  withFile(lines, (path) => {
    expect(indexTranscript(path, 'claude', noStats)?.totalLines).toBe(600);
    // Same path, different conversation. Every stored offset now points into other records, and
    // reusing them would be wrong silently — the reader would show real lines from the wrong places.
    const replaced = numbered(20).map((line) => `${line} `);
    writeFileSync(path, replaced.map((line) => `${line}\n`).join(''));
    const rebuilt = indexTranscript(path, 'claude', noStats);
    expect(rebuilt?.totalLines).toBe(20);
    expect(rebuilt?.read(1, 20)).toEqual(replaced);
  });
});

test("another runtime's counts are not inherited", () => {
  const lines = numbered(10);
  withFile(lines, (path) => {
    indexTranscript(path, 'claude', () => ({ ...EMPTY_STATS, messages: 10 }));
    // The stats are whatever that agent's parser made of these lines. A different parser makes
    // different messages out of the same bytes, so the count belongs to the pair, not the file.
    const other = indexTranscript(path, 'codex', () => ({ ...EMPTY_STATS, messages: 3 }));
    expect(other?.stats.messages).toBe(3);
  });
});
