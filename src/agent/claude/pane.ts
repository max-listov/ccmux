import type { PaneScan } from "../index.ts";
import { parseContext } from "../context.ts";

// Scrape model / context-fill / working-idle from what claude renders in the pane (the
// model banner + statusline + the working spinner). Pure: rendered text → status. The
// pane CAPTURE lives in core (tmux); this is the Claude-specific READING. Mirrors bash
// `pane_status`. Anything claude doesn't surface stays null — we never invent a window.

// claude 2.1.x shows a STAR-spinner glyph + verb while working. The LIVE spinner is
// present-continuous and ends in an ellipsis ("✻ Transmuting…", "✽ Churning…"); when the
// turn FINISHES the line collapses to a past-tense completion marker that LINGERS in the
// scrollback ("✻ Worked for 4s", "✻ Churned for 3s"). Matching the bare glyph caught those
// stale markers → every idle session read as "working". Only the ellipsis form (or the
// explicit "esc to interrupt") means working RIGHT NOW. Completion markers have no "…".
const WORKING_RE = /[✱-✿] [A-Za-z ]+…|esc to interrupt/;
const MODEL_RE = /(Opus|Sonnet|Haiku) [\d.]+/;
const CONTEXT_RE = /[\d.]+[kKMG]\/[\d.]+[kKMG] +\d+%/;

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
