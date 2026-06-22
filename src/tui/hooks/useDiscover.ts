import { useEffect, useState } from "react";
import { discoverActive } from "../discover.ts";
import type { DiscoveredSession } from "../discover.ts";
import type { MachineConfig } from "../../types.ts";

/** Poll for live Claude sessions running outside ccmux (read-only discovery). Slower
 *  interval than the fleet poll — scanning transcripts is heavier than a pane capture. */
export function useDiscover(m: MachineConfig, enabled: boolean, intervalMs = 4000): DiscoveredSession[] {
  const [list, setList] = useState<DiscoveredSession[]>([]);
  useEffect(() => {
    if (!enabled) {
      setList([]);
      return;
    }
    let alive = true;
    const load = (): void => {
      try {
        const d = discoverActive(m);
        if (alive) setList(d);
      } catch {
        // best-effort
      }
    };
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [m, enabled, intervalMs]);
  return list;
}
