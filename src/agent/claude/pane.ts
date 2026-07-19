import type { PaneScan } from "../index.ts";
import type { MachineConfig } from "../../types.ts";
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

// Claude 2.1.x shows an interactive picker on `--resume` of a large/old session that BLOCKS
// the pane until a choice is made:
//   ❯ 1. Resume from summary (recommended)
//     2. Resume full session as-is
//     3. Don't ask me again
// A daemon-healed resume has nobody to answer it, so after a reboot the session strands at
// this menu — typed input (app or tmux) lands on the MENU, not the conversation. We confirm
// it's really the picker (BOTH exact option labels present, so a conversation merely mentioning
// "resume from summary" doesn't trigger) and return the option NUMBER next to the policy target
// line — read from the pane, so a reordered menu still yields the correct key. "off" → never.
const PICKER_SUMMARY = "Resume from summary";
const PICKER_FULL = "Resume full session as-is";

export function resumePickerAnswer(paneText: string, m: MachineConfig): string | null {
  if (m.resumePicker === "off") return null;
  if (!paneText.includes(PICKER_SUMMARY) || !paneText.includes(PICKER_FULL)) return null;
  const label = m.resumePicker === "summary" ? PICKER_SUMMARY : PICKER_FULL;
  const match = paneText.match(new RegExp(String.raw`(\d+)\.\s*${label}`));
  return match?.[1] ?? null;
}
