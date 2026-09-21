import { describe, expect, test } from 'bun:test';
import type { DiscoveredSession } from '../src/tui/discover.ts';
import { externalInlineLines } from '../src/tui/externalView.ts';
import type { FleetItem } from '../src/tui/fleet.ts';
import { inlineCardRows, inlineFit, inlineMaxStart, inlineReveal } from '../src/tui/listWindow.ts';

/** Only `external` decides an inline card's height, so the fixtures carry nothing else. */
const items = (managed: number, external = 0): FleetItem[] => [
  ...Array.from({ length: managed }, (_, i) => ({ key: `m${i}`, external: false }) as FleetItem),
  ...Array.from({ length: external }, (_, i) => ({ key: `x${i}`, external: true }) as FleetItem),
];
/** What the view actually spends on the slice it renders — the number the terminal cares about. */
const rowsUsed = (list: FleetItem[], start: number, n: number, externalStart: number): number =>
  list
    .slice(start, start + n)
    .reduce((sum, it, k) => sum + inlineCardRows(it) + (start + k === externalStart ? 1 : 0), 0);

describe('inline list window', () => {
  test('fits whole cards only, three rows each', () => {
    const list = items(10);
    expect(inlineFit(list, 0, 12, 10)).toBe(4);
    expect(inlineFit(list, 0, 11, 10)).toBe(3); // the fourth card would overflow by two rows
  });

  test('the external separator costs a row of the window', () => {
    const list = items(2, 3); // externalStart = 2
    // 2 managed (6) + separator (1) + 1 external (4) = 11
    expect(inlineFit(list, 0, 11, 2)).toBe(3);
    expect(inlineFit(list, 0, 10, 2)).toBe(2); // no room for the separator plus its first card
  });

  test('a card taller than the terminal still renders rather than leaving the list blank', () => {
    expect(inlineFit(items(0, 1), 0, 2, 0)).toBe(1);
  });

  test('the last card lands on the last row, not in empty space', () => {
    const list = items(10);
    const start = inlineMaxStart(list, 12, 10);
    expect(start).toBe(6); // the final four cards fill twelve rows exactly
    expect(rowsUsed(list, start, inlineFit(list, start, 12, 10), 10)).toBeLessThanOrEqual(12);
  });

  test('moving down past the window scrolls by one, moving up jumps to the item', () => {
    const list = items(10);
    expect(inlineReveal(list, 0, 3, 12, 10)).toBe(0); // still inside a four-card window
    expect(inlineReveal(list, 0, 4, 12, 10)).toBe(1);
    expect(inlineReveal(list, 5, 2, 12, 10)).toBe(2);
  });

  // The bug this guards was never about HOW MANY sessions there are — a frame taller than the
  // terminal is scrolled by the terminal whether it is twenty rows too tall or two hundred.
  test.each([
    [17, 76],
    [200, 0],
    [200, 300],
  ])('every revealed window fits the terminal (%i managed, %i external)', (managed, external) => {
    const list = items(managed, external);
    const externalStart = managed;
    const rows = 24;
    let top = 0;
    for (let cur = 0; cur < list.length; cur++) {
      top = inlineReveal(list, top, cur, rows, externalStart);
      const visible = inlineFit(list, top, rows, externalStart);
      expect(cur).toBeGreaterThanOrEqual(top);
      expect(cur).toBeLessThan(top + visible);
      expect(rowsUsed(list, top, visible, externalStart)).toBeLessThanOrEqual(rows);
    }
  });
});

describe('inline external card body', () => {
  const ext = {
    provider: 'codex',
    host: 'host-a',
    threadId: '01a0bd55-7e54-7872-9de9-32dd5ebeb1c1',
    origin: 'vscode',
    storage: 'stored',
    dir: '/Users/u/home/projects/some/deep/directory/that/keeps/going/and/going',
    writerEvidence: 'none-observed',
    writerRuntime: null,
    capabilities: {
      inspect: true,
      attemptAdopt: true,
      fork: true,
      terminateAndAdopt: false,
      releaseAtSource: false,
      reasons: ['no writer was observed; adoption must still revalidate atomically'],
    },
  } as unknown as DiscoveredSession;

  test('is two rows, each within the column budget the window paid for', () => {
    const lines = externalInlineLines(ext, 60);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    expect(lines[1]).toContain('cwd ');
  });

  test('the evidence line is clipped, not wrapped — an unclipped one is far longer', () => {
    const [evidence] = externalInlineLines(ext, 60);
    expect(evidence.length).toBeLessThanOrEqual(60);
    expect(evidence).toStartWith('codex@host-a');
  });
});
