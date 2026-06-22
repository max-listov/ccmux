import type { PaneScan } from "../index.ts";
import { parseContext } from "../context.ts";

// Codex live-pane scrape. Codex renders its TUI differently from Claude, so the
// model/context/working markers differ. These regexes are a first pass; they need
// calibration against a real running Codex pane (TODO: codex-launch spike). Until then
// the worst case is a blank model/context in `list` — never wrong data.

const WORKING_RE = /esc to interrupt|working\b|·\s*\d+s\b/i;
const MODEL_RE = /\b(gpt-[\w.-]+|o\d[\w.-]*|codex[\w.-]*)\b/i;
const CONTEXT_RE = /[\d.]+[kKMG]\/[\d.]+[kKMG] +\d+%|\d+%\s*context/i;

export function scanPane(paneText: string): PaneScan {
  const tail = paneText.split("\n").slice(-30).join("\n");
  const contextLabel = tail.match(CONTEXT_RE)?.[0] ?? null;
  return {
    model: tail.match(MODEL_RE)?.[0] ?? null,
    state: WORKING_RE.test(tail) ? "working" : "idle",
    contextLabel: contextLabel ?? "-",
    context: parseContext(contextLabel),
  };
}
