import { useEffect, useState } from "react";
import { discoverActive } from "../discover.ts";
import type { DiscoveredSession } from "../discover.ts";
import type { MachineConfig } from "../../types.ts";

/** Discovery reads transcripts and shells out to lsof/ps — it is synchronous and it BLOCKS.
 *  Running it straight from the effect froze the very first frame: the fleet's own load is a
 *  promise, and a blocked loop cannot deliver one, so the view sat at zeros showing neither
 *  managed nor external. Announcing the scan and then yielding lets that frame reach the
 *  terminal before the thread is busy. */
const YIELD_MS = 50;

/** Poll for agent threads running outside ccmux (read-only discovery). Slower interval than the
 *  fleet poll — scanning transcripts is heavier than a pane capture. `scanning` is true from the
 *  moment a pass is announced until it returns, so the view can say what it is doing. */
export function useDiscover(
  m: MachineConfig,
  enabled: boolean,
  intervalMs = 4000,
): { list: DiscoveredSession[]; scanning: boolean } {
  const [list, setList] = useState<DiscoveredSession[]>([]);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setList([]);
      setScanning(false);
      return;
    }
    let alive = true;
    let yieldTimer: ReturnType<typeof setTimeout> | undefined;
    const load = (): void => {
      setScanning(true);
      yieldTimer = setTimeout(() => {
        try {
          const d = discoverActive(m);
          if (alive) setList(d);
        } catch {
          // best-effort
        } finally {
          if (alive) setScanning(false);
        }
      }, YIELD_MS);
    };
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
      if (yieldTimer !== undefined) clearTimeout(yieldTimer);
    };
  }, [m, enabled, intervalMs]);
  return { list, scanning };
}
