import { stripAnsi } from '../../tmux/tmux.ts';
import { parseContext } from '../context.ts';
import type { ChatPaneInspection, PaneScan } from '../index.ts';

const WORKING_RE = /\bWorking\b[^\n]*(?:esc to interrupt|\d+s)/i;
const WORKED_RE = /\bWorked for\b/i;
const FOOTER_RE = /^\s*gpt-[^\n]+\s+·\s+.+$/m;
const DRAFT_FOOTER_RE = /^\s*tab to queue message\s+\d+% context left\s*$/m;
const CONTEXT_RE = /[\d.]+[kKMG]\/[\d.]+[kKMG] +\d+%|\d+%\s*context/i;
const MENU_CONFIRM_RE =
  /Press enter to (?:continue|confirm)|Press enter to confirm or esc to go back/i;
const MENU_OPTION_RE = /^\s*(?:›\s*)?\d+\.\s+\S/m;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI dim runs require the literal ESC byte.
const DIM_RUN_RE = /\u001b\[2m[\s\S]*?(?:\u001b\[(?:0|22)m|$)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip native terminal SGR sequences, including ESC.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function menuTitle(plain: string): string | null {
  const tail = plain.split('\n').slice(-40).join('\n');
  if (!MENU_CONFIRM_RE.test(tail) || !MENU_OPTION_RE.test(tail)) return null;
  const rawLines = tail.split('\n');
  let confirmAt = -1;
  let newerChromeAt = -1;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i] ?? '';
    if (MENU_CONFIRM_RE.test(line)) confirmAt = i;
    if (/^\s*›/.test(line) || /^\s*gpt-[^\n]+\s+·\s+.+$/.test(line)) newerChromeAt = i;
  }
  if (newerChromeAt > confirmAt) return null;
  const lines = rawLines.map((line) => line.trim()).filter((line) => line !== '');
  return (
    lines.find((line) => /^(?:Do you |Hooks need review|Would you |Allow |Approve )/i.test(line)) ??
    'Codex selection prompt'
  );
}

function composerLine(styled: string): string | null {
  const lines = styled.split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const line = lines[i];
    // biome-ignore lint/suspicious/noControlCharactersInRegex: The native composer marker can follow ANSI SGR bytes.
    if (line !== undefined && /^\s*(?:\u001b\[[0-9;]*m)*›/.test(line)) {
      const tail = lines.slice(i);
      const footer = tail.findIndex(
        (text, index) =>
          index > 0 && (FOOTER_RE.test(stripAnsi(text)) || DRAFT_FOOTER_RE.test(stripAnsi(text))),
      );
      return tail.slice(0, footer < 0 ? undefined : footer).join('\n');
    }
  }
  return null;
}

function composerOccupied(line: string | null): boolean {
  if (line === null) return false;
  const after = line.slice(line.indexOf('›') + 1);
  // Codex, like Claude, may dim only the proposed completion after real typed bytes. Dropping the
  // whole line when ANY dim SGR exists turns `typed<dim completion>` into an empty composer.
  return after.replace(DIM_RUN_RE, '').replace(ANSI_RE, '').trim() !== '';
}

function liveWorking(plain: string): boolean {
  const lines = plain.split('\n').slice(-40);
  let workingAt = -1;
  let workedAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (WORKING_RE.test(line)) workingAt = i;
    if (WORKED_RE.test(line)) workedAt = i;
  }
  return workingAt > workedAt;
}

/** One classifier owns every Codex pane decision. Delivery is allowed only on the complete idle
 * composer shape measured from Codex CLI 0.147.0; every new or cropped frame fails closed. */
export function inspectChatPane(styledPaneText: string): ChatPaneInspection {
  return inspectInput(styledPaneText, true);
}

/** Native turn state is already authoritative. Only menus, typed bytes and known composer chrome
 * are read from its client; a client-side background spinner is not a provider turn. */
export function inspectNativeCodexInput(styledPaneText: string): ChatPaneInspection {
  return inspectInput(styledPaneText, false);
}

function inspectInput(styledPaneText: string, inspectActivity: boolean): ChatPaneInspection {
  const plain = stripAnsi(styledPaneText);
  const prompt = menuTitle(plain);
  if (prompt !== null)
    return {
      state: 'menu',
      reason: `recipient is at a selection menu (${prompt}) — injecting would choose for it`,
    };
  const composer = composerLine(styledPaneText);
  if (inspectActivity && liveWorking(plain)) {
    return composerOccupied(composer)
      ? {
          state: 'queued-input',
          reason:
            'the recipient is working with queued input already in its composer — delivery waits rather than merging with it',
        }
      : {
          state: 'working',
          reason: 'the recipient is working right now — Codex delivery waits for its idle composer',
        };
  }
  if (plain.trim() === '')
    return {
      state: 'not-drawn',
      reason: "the recipient's UI has not painted yet (starting or resuming)",
    };

  if (composerOccupied(composer) && (FOOTER_RE.test(plain) || DRAFT_FOOTER_RE.test(plain))) {
    return {
      state: 'input-busy',
      reason:
        'that Codex pane has unsent text in its composer — delivery waits rather than appending to it',
    };
  }
  if (composer === null || !FOOTER_RE.test(plain)) {
    return {
      state: 'unknown',
      reason:
        'the Codex pane is drawn in an unknown shape — delivery is held until a proven idle composer appears',
    };
  }
  return { state: 'deliverable', reason: 'ready' };
}

export function scanPane(paneText: string): PaneScan {
  const plain = stripAnsi(paneText);
  const tail = plain.split('\n').slice(-40).join('\n');
  const contextLabel = tail.match(CONTEXT_RE)?.[0] ?? null;
  const prompt = menuTitle(plain);
  const inspection = inspectChatPane(paneText);
  const context = parseContext(contextLabel);
  return {
    ready:
      prompt !== null ||
      inspection.state === 'deliverable' ||
      inspection.state === 'input-busy' ||
      inspection.state === 'working',
    state:
      inspection.state === 'working' || inspection.state === 'queued-input'
        ? 'working'
        : inspection.state === 'deliverable' || inspection.state === 'input-busy'
          ? 'idle'
          : 'indeterminate',
    atPrompt: prompt,
    contextLabel: contextLabel ?? '-',
    context,
  };
}
