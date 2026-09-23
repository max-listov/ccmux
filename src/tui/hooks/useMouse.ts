import { useStdin, useStdout } from 'ink';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import { cardIndexAtY } from '../listWindow.ts';
import { MOTION, sgrReports, WHEEL_DOWN, WHEEL_UP } from '../mouse.ts';
import { describeSgr, logMouse, mouseDebugOn } from '../mouseProbe.ts';

export type Focus = 'list' | 'transcript';

/** Where things are on screen this render. */
export interface MouseGeometry {
  listWidth: number;
  minListWidth: number;
  winStart: number;
  visibleCards: number;
  count: number;
  externalStart: number;
  /** Largest top card the list window may scroll to. */
  maxScrollTop: number;
  /** Largest transcript offset. */
  maxScroll: number;
}

/** What a gesture changes. */
export interface MouseActions {
  setListScroll: Dispatch<SetStateAction<number>>;
  setOffset: Dispatch<SetStateAction<number>>;
  setFocus: (focus: Focus) => void;
  setListWidth: (width: number) => void;
  selectAt: (index: number) => void;
}

/**
 * The fullscreen view's mouse: the wheel scrolls the pane under the pointer (by x, whatever has
 * focus), a press selects a card or focuses a pane, and the divider is a hover/drag handle for a
 * live resize.
 *
 * Any-motion tracking (?1003h) is what gives hover and drag, and it reports on every pointer move —
 * so events are handled in memory only, never logged by default, or they flood the disk. The
 * listener is attached once per fullscreen session and reads the render's values through a ref: a
 * drag changes the width on every motion, and re-attaching then would drop the gesture mid-way.
 */
export function useMouse(active: boolean, geometry: MouseGeometry, actions: MouseActions) {
  const { stdout } = useStdout();
  const { stdin } = useStdin();
  const latest = useRef({ geometry, actions });
  latest.current = { geometry, actions };
  const dragging = useRef(false);
  const [hoverHandle, setHoverHandle] = useState(false);
  const [hoverPane, setHoverPane] = useState<Focus | null>(null);
  const [hoverCard, setHoverCard] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    stdout?.write('\x1b[?1003h\x1b[?1006h');
    const onData = (data: Buffer): void => {
      const raw = data.toString();
      if (!raw.includes('\x1b[<')) return;
      if (mouseDebugOn) logMouse('STDIN', describeSgr(raw));
      for (const { button, x, y, release } of sgrReports(raw)) {
        const { geometry: g, actions: a } = latest.current;
        const nearHandle = Math.abs(x - (g.listWidth + 1)) <= 1;
        const zone: Focus = x <= g.listWidth ? 'list' : 'transcript';
        const cardAt = () => cardIndexAtY(y, g.winStart, g.visibleCards, g.count, g.externalStart);
        if (button === WHEEL_UP || button === WHEEL_DOWN) {
          const up = button === WHEEL_UP;
          // Over the list the wheel SCROLLS the window and leaves the selection alone.
          if (zone === 'list')
            a.setListScroll((s) => Math.max(0, Math.min(s + (up ? -1 : 1), g.maxScrollTop)));
          else a.setOffset((o) => Math.min(Math.max(0, o + (up ? 1 : -1)), g.maxScroll));
          continue;
        }
        if (button === 0 && !release) {
          if (nearHandle) {
            dragging.current = true;
            setHoverHandle(true);
          } else if (zone === 'list') {
            const index = cardAt();
            if (index !== null) {
              a.selectAt(index);
              a.setOffset(0);
            }
            a.setFocus('list');
          } else a.setFocus(zone);
          continue;
        }
        if (release) {
          dragging.current = false;
          setHoverHandle(nearHandle);
          continue;
        }
        if ((button & MOTION) === 0) continue;
        if (dragging.current) {
          const cols = stdout?.columns ?? 100;
          a.setListWidth(Math.max(g.minListWidth, Math.min(cols - 30, x - 1)));
        } else {
          setHoverHandle(nearHandle);
          setHoverPane(zone);
          setHoverCard(zone === 'list' ? cardAt() : null);
        }
      }
    };
    stdin?.on('data', onData);
    return () => {
      stdin?.off('data', onData);
      stdout?.write('\x1b[?1003l\x1b[?1006l');
    };
  }, [active, stdout, stdin]);

  return { hoverHandle, hoverPane, hoverCard };
}
