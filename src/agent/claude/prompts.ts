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
export type PromptKind =
  | 'resume-picker'
  | 'folder-trust'
  | 'declared-permissions'
  | 'external-imports'
  | 'unrecognised';

export type PanePrompt = {
  kind: PromptKind;
  /** Short human title for the status column — what the session is actually waiting on. */
  title: string;
};

export const PICKER_SUMMARY = 'Resume from summary';
export const PICKER_FULL = 'Resume full session as-is';
export const TRUST_YES = 'Yes, I trust this folder';
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

/**
 * The menu the pane is showing NOW, as its own text, or null when the footer on screen belongs to a
 * frame that has since been drawn over.
 *
 * A menu that was refused leaves its last frame in the pane when the agent exits, and the relaunched
 * agent draws its menu again beneath it: the visible screen then holds the question twice. Counting
 * options across both frames made the menu unreadable (so the supervisor never answered it) and
 * reading the older one would answer a question that is no longer asked. The live frame is the one
 * that ends the screen: the text after the LAST footer must be blank, and the frame starts after the
 * footer before it. A screen with no footer is returned unchanged (the numbered picker has none).
 */
export function liveFrame(paneText: string): string | null {
  const lines = paneText.trimEnd().split('\n');
  const footers: number[] = [];
  lines.forEach((line, i) => {
    if (MENU_FOOTER_RE.test(line)) footers.push(i);
  });
  const last = footers.at(-1);
  if (last === undefined) return paneText;
  // Something was drawn below the footer: the frame it ends is not the one on screen.
  if (last !== lines.length - 1) return null;
  const before = footers.at(-2);
  return lines.slice(before === undefined ? 0 : before + 1).join('\n');
}

export function paneTail(paneText: string, lines = 20): string {
  return paneText.trimEnd().split('\n').slice(-lines).join('\n');
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
  if (tail.includes('No, disable external imports') && tail.includes('Yes, allow'))
    return { kind: 'external-imports', title: 'allow external imports' };
  return { kind: 'unrecognised', title: "a choice we don't recognise" };
}

/** Only complete known option sets are actionable. Numbered and unnumbered menus share labels. */
export function terminalMenu(paneText: string) {
  const prompt = detectPrompt(paneText);
  if (!prompt) return null;
  const labels =
    prompt.kind === 'resume-picker'
      ? [PICKER_SUMMARY, PICKER_FULL]
      : prompt.kind === 'external-imports'
        ? ['No, disable external imports', 'Yes, allow']
        : prompt.kind === 'folder-trust' || prompt.kind === 'declared-permissions'
          ? ['No, exit', TRUST_YES]
          : [];
  const options: { id: string; label: string }[] = [];
  let selected: number | null = null;
  for (const line of paneTail(paneText, 40).split('\n')) {
    const match = line.trim().match(/^(❯\s*)?(?:\d+\.\s*)?(.+?)\s*$/);
    const label = match?.[2];
    if (!label || !labels.includes(label)) continue;
    if (match?.[1]) selected = options.length;
    options.push({ id: String(labels.indexOf(label)), label });
  }
  const actionable =
    labels.length > 0 &&
    options.length === labels.length &&
    new Set(options.map((o) => o.id)).size === labels.length &&
    selected !== null;
  return { ...prompt, options: actionable ? options : [], selected: actionable ? selected : null };
}

/** Whether the machine's policy covers this prompt. The levels escalate, so a machine that accepts
 *  declared permissions necessarily also trusts the directory. */
export function policyAnswers(kind: PromptKind, m: MachineConfig): boolean {
  if (kind === 'resume-picker') return m.resumePicker !== 'off';
  if (kind === 'folder-trust') return m.trustPrompt !== 'off';
  if (kind === 'declared-permissions') return m.trustPrompt === 'declared';
  return false; // never guess at a menu we cannot read
}
