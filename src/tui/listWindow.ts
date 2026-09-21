import type { FleetItem } from './fleet.ts';

/**
 * The scroll window both views share.
 *
 * A terminal frame taller than the terminal is not a long page — it is a frame the terminal
 * SCROLLS. Ink rewrites its frame in place only while the frame fits; past that every repaint
 * (a keypress, a 1.5 s poll) lands at the bottom of the scrollback, so a person who scrolled up
 * to read the top is thrown back down by the next tick and their arrow key looks like it jumped.
 * The fix is not a scroll position to restore — it is rendering only what fits, in both views.
 *
 * Fullscreen cards are a fixed 7-row frame plus a 1-row gap. Inline cards are two rows (name,
 * last action) plus a gap, and an external card carries two evidence rows instead of one, so the
 * inline window counts ITEM HEIGHTS rather than dividing by a stride.
 */

// Fullscreen card geometry (must match FullscreenView's framed SessionCard layout) so a
// mouse Y can be mapped to a card index. header(1) + pane top-border(1) → first card at
// terminal row 3; each framed card is 6 rows; the external separator adds 1 row.
export const CARD_TOP = 3; // header bar (1) + pane top border (1) → first card body at row 3
export const CARD_H = 8; // stride: 7-row card + 1-row gap
export const CARD_BODY = 7; // clickable rows (the gap is dead space)

/** How many whole cards fit in the (clipped) fullscreen list pane. N cards take N·CARD_BODY +
 *  (N−1) gaps = N·CARD_H − 1 rows (the last card has no trailing gap), so +1 before dividing. */
export function visibleCardCount(termRows: number): number {
  const interior = Math.max(1, termRows - 4); // minus header(1) footer(1) + pane top/bottom border(2)
  return Math.max(1, Math.floor((interior + 1) / CARD_H));
}

/** Map a terminal Y to a GLOBAL card index, accounting for the scroll window + the one-row
 *  external separator. Mirrors FullscreenView's windowed layout exactly. */
export function cardIndexAtY(
  y: number,
  winStart: number,
  visible: number,
  count: number,
  externalStart: number,
): number | null {
  let rowY = CARD_TOP;
  for (let k = 0; k < visible; k++) {
    const gi = winStart + k;
    if (gi >= count) break;
    if (gi === externalStart && externalStart < count) rowY += 1; // separator row above the first external card
    if (y >= rowY && y < rowY + CARD_BODY) return gi;
    rowY += CARD_H;
  }
  return null;
}

/** Rows the inline view spends on everything that is not a card: the top and bottom padding of
 *  the block, the header, the blank line under it and the key hints. */
export const INLINE_CHROME_ROWS = 5;

/** Rows one inline card occupies, its trailing gap included. An external card shows two
 *  evidence rows (writer/capability line and cwd) where a managed card shows the last action. */
export function inlineCardRows(item: FleetItem): number {
  return item.external ? 4 : 3;
}

/** Rows item `i` costs in the window, separator included: the external section opens with a
 *  one-row rule above its first card. */
function rowsAt(items: readonly FleetItem[], i: number, externalStart: number): number {
  const item = items[i];
  if (item === undefined) return 0;
  return inlineCardRows(item) + (i === externalStart ? 1 : 0);
}

/** How many items fit under `rows` starting at `start`. Never zero while items remain: a card
 *  taller than the terminal is still shown, clipped, rather than leaving the list blank. */
export function inlineFit(
  items: readonly FleetItem[],
  start: number,
  rows: number,
  externalStart: number,
): number {
  let used = 0;
  let n = 0;
  for (let i = Math.max(0, start); i < items.length; i++) {
    const h = rowsAt(items, i, externalStart);
    if (used + h > rows && n > 0) break;
    used += h;
    n++;
  }
  return Math.min(Math.max(n, items.length === 0 ? 0 : 1), items.length - Math.max(0, start));
}

/** The furthest the inline window can scroll: the smallest start whose tail fits whole, so the
 *  last card always lands on the last row instead of scrolling into empty space. */
export function inlineMaxStart(
  items: readonly FleetItem[],
  rows: number,
  externalStart: number,
): number {
  if (items.length === 0) return 0;
  let used = 0;
  let start = items.length - 1; // the last card is always reachable, even if it alone overflows
  for (let i = items.length - 1; i >= 0; i--) {
    const h = rowsAt(items, i, externalStart);
    if (used + h > rows) break;
    used += h;
    start = i;
  }
  return start;
}

/** Scroll the inline window the minimum needed to bring `cursor` into view. */
export function inlineReveal(
  items: readonly FleetItem[],
  top: number,
  cursor: number,
  rows: number,
  externalStart: number,
): number {
  const max = inlineMaxStart(items, rows, externalStart);
  let t = Math.min(Math.max(0, top), max);
  if (cursor < t) return cursor;
  while (cursor >= t + inlineFit(items, t, rows, externalStart) && t < items.length - 1) t++;
  return t;
}
