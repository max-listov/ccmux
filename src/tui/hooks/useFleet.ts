import { useEffect, useState } from "react";
import { collectRows } from "../../commands/list.ts";
import type { ListRow } from "../../commands/list.ts";
import type { MachineConfig } from "../../types.ts";

/** Poll the live fleet on an interval. `reload()` forces an immediate refresh (after an action like
 *  stop/restart). Single data source — same `collectRows` the CLI uses. `liveNamesRef` (optional) is
 *  read at each tick to tell collectRows which panes to capture (visible cards) — a ref so scrolling
 *  doesn't re-subscribe the interval. */
export function useFleet(
  m: MachineConfig,
  liveNamesRef?: { current: Set<string> | undefined },
  intervalMs = 1500,
): { rows: ListRow[]; reload: () => void } {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void collectRows(m, liveNamesRef?.current ? { liveNames: liveNamesRef.current } : undefined).then((r) => {
        if (alive) setRows(r);
      });
    };
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [m, intervalMs, nonce, liveNamesRef]);
  return { rows, reload: () => setNonce((n) => n + 1) };
}
