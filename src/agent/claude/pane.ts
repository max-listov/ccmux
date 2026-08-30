import { stripAnsi } from '../../tmux/tmux.ts';
import { parseContext } from '../context.ts';
import type { ChatPaneInspection, PaneScan } from '../index.ts';
import { atInteractiveMenu as atMenu, detectPrompt as detectPromptImpl } from './prompts.ts';

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
  const tail = paneText.split('\n').slice(-30).join('\n');
  const contextLabel = tail.match(CONTEXT_RE)?.[0] ?? null;
  // A menu blocks the pane, so the session is not idle no matter how still it looks. Reporting the
  // prompt here is what stops `list` from calling a session waiting on a human "idle".
  const prompt = detectPromptImpl(paneText);
  return {
    ready: READY_MARKERS.some((re) => re.test(tail)),
    // The star spinner has blank animation frames, so its absence in one capture proves nothing
    // about a turn boundary. Stop/lifecycle and bounded turn evidence decide idle outside the pane.
    state: WORKING_RE.test(tail) ? 'working' : 'indeterminate',
    atPrompt: prompt === null ? null : prompt.title,
    contextLabel: contextLabel ?? '-',
    context: parseContext(contextLabel),
  };
}

// Blocking selection menus — WHICH one is up, and the keystroke that answers it — now live in a
// table (./prompts.ts) rather than as one hard-coded case here. Re-exported so the provider contract
// and the chat-delivery guard keep their existing names.
export { atInteractiveMenu, detectPrompt, promptAnswer } from './prompts.ts';

/** Safe to inject an inter-agent chat message into this pane right now? The only unsafe state is
 *  a selection menu (would pick an option). WORKING is safe — Claude QUEUES typed input and runs
 *  it at the next turn boundary (proven live), so a busy agent is never interrupted, just queued. */
export function chatDeliverable(paneText: string): boolean {
  return !atMenu(paneText);
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
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI dim runs require the literal ESC byte.
const DIM_RUN_RE = /\u001b\[2m[\s\S]*?(?:\u001b\[(?:0|22)m|$)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip native terminal SGR sequences, including ESC.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function inputBusy(styledPaneText: string): boolean {
  const tail = styledPaneText.split('\n').slice(-COMPOSER_TAIL_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (line === undefined || !line.includes('❯')) continue;
    const after = line.slice(line.indexOf('❯') + 1);
    const typed = after.replace(DIM_RUN_RE, '').replace(ANSI_RE, '').trim();
    return typed !== '';
  }
  return false; // no composer in view (booting / alt-screen) → nothing typed to clobber
}

export function inspectChatPane(styledPaneText: string): ChatPaneInspection {
  const paneText = stripAnsi(styledPaneText);
  if (atMenu(paneText)) {
    return {
      state: 'menu',
      reason: 'recipient is at a selection menu — injecting would pick an option it never chose',
    };
  }
  if (inputBusy(styledPaneText)) {
    return {
      state: 'input-busy',
      reason:
        'that pane has unsent text in its composer — delivery waits rather than appending to it',
    };
  }
  const scan = scanPane(paneText);
  if (!scan.ready)
    return {
      state: 'not-drawn',
      reason: "the recipient's UI has not painted yet (starting or resuming)",
    };
  return { state: 'deliverable', reason: 'ready' };
}
