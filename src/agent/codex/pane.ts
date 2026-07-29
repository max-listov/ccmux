import type { PaneScan } from "../index.ts";
import { parseContext } from "../context.ts";

// Codex live-pane scrape. Codex renders its TUI differently from Claude, so the working/context
// markers differ. These regexes are a first pass; they need calibration against a real running
// Codex pane (TODO: codex-launch spike). Until then the worst case is a blank context in `list` —
// never wrong data. The MODEL is NOT scraped here — it comes from jsonl (turn_context.model, source
// of truth), same as Claude, so no pane whitelist to keep in sync.

const WORKING_RE = /esc to interrupt|working\b|·\s*\d+s\b/i;
const CONTEXT_RE = /[\d.]+[kKMG]\/[\d.]+[kKMG] +\d+%|\d+%\s*context/i;

export function scanPane(paneText: string): PaneScan {
  const tail = paneText.split("\n").slice(-30).join("\n");
  const contextLabel = tail.match(CONTEXT_RE)?.[0] ?? null;
  const context = parseContext(contextLabel);
  return {
    // Codex chrome isn't calibrated yet, so "ready" is best-effort: it's up if it's working or has
    // rendered a context readout. waitReady has a timeout fallback, so a miss just slows a restart.
    ready: WORKING_RE.test(tail) || context.text !== null,
    state: WORKING_RE.test(tail) ? "working" : "idle",
    contextLabel: contextLabel ?? "-",
    context,
  };
}
