import { useEffect, useState } from 'react';
import type { ListRow } from '../../commands/list.ts';
import { collectRows } from '../../commands/list.ts';
import type { MachineConfig } from '../../types.ts';

/** Poll the live fleet on an interval. `reload()` forces an immediate refresh (after an action like
 *  stop/restart). Single data source — same `collectRows` the CLI uses. `liveNamesRef` (optional) is
 *  read at each tick to tell collectRows which panes to capture (visible cards) — a ref so scrolling
 *  doesn't re-subscribe the interval.
 *
 *  `loaded` separates "no sessions" from "no answer yet". They render identically as an empty array,
 *  and the view used to state the first while meaning the second — on a box with a full fleet. */
export function useFleet(
  m: MachineConfig,
  liveNamesRef?: { current: Set<string> | undefined },
  intervalMs = 1500,
): { rows: ListRow[]; loaded: boolean; reload: () => void } {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the explicit reload trigger; removing it disables reload().
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void collectRows(
        m,
        liveNamesRef?.current ? { liveNames: liveNamesRef.current } : undefined,
      ).then((r) => {
        if (!alive) return;
        setRows(r);
        setLoaded(true);
      });
    };
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [m, intervalMs, nonce, liveNamesRef]);
  return { rows, loaded, reload: () => setNonce((n) => n + 1) };
}
