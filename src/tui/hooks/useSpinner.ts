import { useEffect, useState } from "react";
import { SPIN } from "../format.ts";

/** Rotating braille spinner frame. Ticks ONLY while `active` — i.e. at least one visible session
 *  is actually working. An idle fleet must NOT re-render the whole Ink tree 8×/s forever: that
 *  full-tree churn (markdown re-parse per visible line, height recalcs) pegged a core and, when a
 *  TUI orphaned, burned ~80% CPU for 14h with no window open. 200ms is smooth for braille and
 *  halves the re-renders even when something IS working. */
export function useSpinner(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setI((x) => x + 1), 200);
    return () => clearInterval(id);
  }, [active]);
  return SPIN[i % SPIN.length] ?? SPIN[0];
}
