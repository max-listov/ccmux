import type { MachineConfig } from '../../types.ts';

/**
 * Claude's blocking selection menus, as a table rather than one hard-coded case.
 *
 * A supervised session has nobody sitting at it, so any menu that blocks the pane strands it
 * indefinitely: typed input lands on the MENU, not the conversation. ccmux already answered exactly
 * one of these (the resume picker) and every other menu stranded the session in silence — which is
 * how six of twelve sessions came back from a restart unable to do anything while reporting `idle`.
 *
 * The classification exists so the two questions here are never conflated. Trusting the DIRECTORY a
 * session was deliberately registered in is a decision the owner already made by creating it.
 * Accepting tool permissions that a FILE INSIDE that directory declares is a different decision that
 * nobody has made yet, and answering it automatically would hand any checked-in
 * `.claude/settings.local.json` its permissions unread.
 */
export type PromptKind = 'resume-picker' | 'folder-trust' | 'declared-permissions' | 'unrecognised';

export type PanePrompt = {
  kind: PromptKind;
  /** Short human title for the status column — what the session is actually waiting on. */
  title: string;
};

const PICKER_SUMMARY = 'Resume from summary';
const PICKER_FULL = 'Resume full session as-is';
const TRUST_LINE = 'trust this folder';
const DECLARED_LINE = 'pre-approves';

/** EVERY Claude selection menu renders the highlighted option as `❯ N.` (a cursor on a NUMBERED
 *  option). The normal input prompt is `❯ ` followed by the user's text, NEVER `❯ <digit>.`, so this
 *  one pattern positively identifies "a blocking menu is up". Matched against the pane TAIL: the
 *  live menu is always at the bottom, and a numbered list in scrollback is not a prompt. */
const MENU_CURSOR_RE = /❯\s*\d+\.\s/;

/**
 * The same menus render their footer even when the options carry no numbers.
 *
 * Measured on a real trust prompt: the options were `❯ No, exit` / `Yes, I trust this folder` with
 * no digits at all, so the cursor pattern above missed it — and the composer detector then read the
 * cursor line as a half-typed message and held delivery with "that pane has unsent text in its
 * composer". A reader sent looking for a composer they can clear finds a modal dialog instead, which
 * is the one thing that sentence cannot be. The footer is rendered by the menu itself and appears
 * nowhere else, so it identifies the state without guessing at option shapes.
 */
const MENU_FOOTER_RE = /Enter to confirm\s*·\s*Esc to cancel/;

export function paneTail(paneText: string, lines = 20): string {
  return paneText.split('\n').slice(-lines).join('\n');
}

export function atInteractiveMenu(paneText: string): boolean {
  const tail = paneTail(paneText);
  return MENU_CURSOR_RE.test(tail) || MENU_FOOTER_RE.test(tail);
}

/** Which menu is up, if any. `unrecognised` is a real answer, not a failure: an unknown menu still
 *  blocks the session, and saying "waiting on a choice we don't know" beats reporting it idle. */
export function detectPrompt(paneText: string): PanePrompt | null {
  if (!atInteractiveMenu(paneText)) return null;
  const tail = paneTail(paneText, 40);
  if (tail.includes(PICKER_SUMMARY) && tail.includes(PICKER_FULL)) {
    return { kind: 'resume-picker', title: 'resume: summary or full' };
  }
  if (tail.includes(TRUST_LINE)) {
    return tail.includes(DECLARED_LINE)
      ? { kind: 'declared-permissions', title: 'trust folder + permissions it declares' }
      : { kind: 'folder-trust', title: 'trust this folder' };
  }
  return { kind: 'unrecognised', title: "a choice we don't recognise" };
}

/** Whether the machine's policy covers this prompt. The levels escalate, so a machine that accepts
 *  declared permissions necessarily also trusts the directory. */
export function policyAnswers(kind: PromptKind, m: MachineConfig): boolean {
  if (kind === 'resume-picker') return m.resumePicker !== 'off';
  if (kind === 'folder-trust') return m.trustPrompt !== 'off';
  if (kind === 'declared-permissions') return m.trustPrompt === 'declared';
  return false; // never guess at a menu we cannot read
}

/** The option NUMBER to press, read FROM THE PANE so a reordered menu still yields the right key. */
function optionNumber(tail: string, label: string): string | null {
  return tail.match(new RegExp(String.raw`(\d+)\.\s*${label}`))?.[1] ?? null;
}

/**
 * The keystroke that answers the menu currently up, per this machine's policy — or null when there
 * is no menu, or the policy declines it. Pure: the caller does the capturing and the sending.
 */
export function promptAnswer(paneText: string, m: MachineConfig): string | null {
  const prompt = detectPrompt(paneText);
  if (prompt === null || !policyAnswers(prompt.kind, m)) return null;
  const tail = paneTail(paneText, 40);
  if (prompt.kind === 'resume-picker') {
    return optionNumber(tail, m.resumePicker === 'summary' ? PICKER_SUMMARY : PICKER_FULL);
  }
  // Both trust variants offer the same affirmative option; read its number rather than assume "1".
  return optionNumber(tail, 'Yes, I trust this folder');
}
