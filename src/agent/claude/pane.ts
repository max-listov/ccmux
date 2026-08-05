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
const CONTEXT_RE = /[\d.]+[kKMG]\/[\d.]+[kKMG] +\d+%/;
/**
 * "Claude's interactive UI is drawn" — gate for the restart wake-note, for trusting the pane over a
 * stale lifecycle record, and (hardest of all) for typing chat into a session at all. The MODEL is
 * deliberately NOT read from the pane — it comes from jsonl (message.model), so a new family
 * (Fable/Mythos/…) is never dropped by a whitelist.
 *
 * Several markers rather than one, because this used to key on `shift+tab to cycle` alone — and that
 * is a HINT, not a piece of the interface. Claude draws the footer as a single line and, once the
 * agent has background shells, it puts their count where the hint was:
 *
 *   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
 *   ⏵⏵ bypass permissions on · 3 shells · ← for agents
 *
 * So any agent that left a background command running read as "not painted yet" FOREVER — measured
 * live across a fleet, exactly the sessions with shells and no others. One wrong marker produced
 * three unrelated-looking symptoms: its deferred mail was held indefinitely, `wait` on it always
 * timed out, and `list` reported it working while it sat idle. Keying on the mode footer — which
 * every mode draws and nothing displaces — is what makes the signal structural; the rest are
 * independent fallbacks so no single cosmetic change can zero it out again.
 */
const READY_MARKERS = [
  /⏵+ [a-z ]+ on\b/, // permission-mode footer: "auto mode on", "bypass permissions on", …
  /\? for shortcuts/, // the default mode's footer (verified present in the claude bundle)
  /esc to interrupt/, // the UI mid-turn
  /shift\+tab to cycle/, // the hint — still valid evidence, no longer the only one
];

export function scanPane(paneText: string): PaneScan {
  const tail = paneText.split("\n").slice(-30).join("\n");
  const contextLabel = tail.match(CONTEXT_RE)?.[0] ?? null;
  return {
    ready: READY_MARKERS.some((re) => re.test(tail)),
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

// EVERY Claude selection menu — permission prompt, plan approval, resume-from-summary — renders
// the highlighted option as `❯ N.` (a cursor on a NUMBERED option). The normal input prompt is
// `❯ ` followed by the user's text, NEVER `❯ <digit>.`. So this one cursor pattern positively
// identifies "a blocking selection menu is up" — the single state where injecting a chat message
// would auto-pick an option the agent never chose (proven live). Match the pane TAIL (the active
// menu is always at the bottom; a numbered list in scrollback isn't the live prompt).
const MENU_CURSOR_RE = /❯\s*\d+\.\s/;

export function atInteractiveMenu(paneText: string): boolean {
  return MENU_CURSOR_RE.test(paneText.split("\n").slice(-20).join("\n"));
}

/** Safe to inject an inter-agent chat message into this pane right now? The only unsafe state is
 *  a selection menu (would pick an option). WORKING is safe — Claude QUEUES typed input and runs
 *  it at the next turn boundary (proven live), so a busy agent is never interrupted, just queued. */
export function chatDeliverable(paneText: string): boolean {
  return !atInteractiveMenu(paneText);
}

// The composer sits in a framed box at the BOTTOM of the pane:
//     ──────────── <rc-name> ──
//     ❯ <what the human has typed, if anything>
//     ──────────────────────────
//     <statusline>
// Injection is `send-keys <literal>` + Enter, so text already sitting there is the one real hazard:
// ours would be appended to the human's half-written line and our Enter would SEND that mush. A human
// merely WATCHING an attached pane is harmless — hence we test "is the composer occupied", not "is
// anyone attached". Only the bottom slice is scanned: Claude also prefixes past user messages with
// `❯`, so grepping the whole pane would read history as live input.
const COMPOSER_TAIL_LINES = 12;

/**
 * Claude draws its own AUTOSUGGESTION in the composer — a proposed next message, rendered DIM the way
 * a shell renders an autocompletion. It is not input: nobody typed it, and it stays on screen until
 * it is accepted or dismissed.
 *
 * Read as plain text it is indistinguishable from something a human typed, so it used to hold a
 * session's mail indefinitely while `inbox` insisted "a human is typing in that pane right now" —
 * with nobody there. Measured on a live pane, the difference is unambiguous:
 *
 *   typed:      `❯ настоящий ввод`                     (no attributes)
 *   suggested:  `❯ \x1b[2mдоделай sp-blocks\x1b[0m`     (SGR 2 — dim)
 *
 * So the composer must be read WITH its attributes, and dim runs dropped before asking whether
 * anything is there. Dropping runs rather than testing "is the whole line dim" is what makes the
 * shell-style case right too: type a few characters and Claude dim-completes the rest — the typed
 * part survives the filter and correctly counts as occupied.
 */
const DIM_RUN_RE = /\u001b\[2m[\s\S]*?(?:\u001b\[(?:0|22)m|$)/g;
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function inputBusy(styledPaneText: string): boolean {
  const tail = styledPaneText.split("\n").slice(-COMPOSER_TAIL_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (line === undefined || !line.includes("❯")) continue;
    const after = line.slice(line.indexOf("❯") + 1);
    const typed = after.replace(DIM_RUN_RE, "").replace(ANSI_RE, "").trim();
    return typed !== "";
  }
  return false; // no composer in view (booting / alt-screen) → nothing typed to clobber
}
