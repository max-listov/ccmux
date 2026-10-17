import { expect, test } from 'bun:test';
import { settleMenu } from '../src/agent/claude/menuStep.ts';
import { scanPane } from '../src/agent/claude/pane.ts';
import { atInteractiveMenu, detectPrompt, policyAnswers } from '../src/agent/claude/prompts.ts';
import { initialMenuSettle } from '../src/agent/menuSettle.ts';
import { deriveStatus } from '../src/tui/status.ts';
import { makeMachine } from './helpers.ts';

const TRUST = `
 Accessing workspace:
 /home/u/proj
 Quick safety check: Is this a project you created or one you trust?
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ 1. Yes, I trust this folder
   2. No, exit
 Enter to confirm · Esc to cancel
`;

const DECLARED = `
 Accessing workspace:
 /home/u/proj
 ⚠ This folder pre-approves 2 tool permissions in .claude/settings.local.json:
   Bash(python3 -c "…") and Read(//home/u/other/**)
 These will apply without asking. Only proceed if you trust this configuration.
 Security guide
 ❯ 1. Yes, I trust this folder
   2. No, exit
 Enter to confirm · Esc to cancel
`;

const PICKER = `
 ❯ 1. Resume from summary (recommended)
   2. Resume full session as-is
   3. Don't ask me again
`;

const CALM = `
──────── host-a-agent ──
❯ what should I do next
────────────────────────
   Opus 5 · 100.0k/1.0M 10%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

test('the three startup menus are told apart', () => {
  expect(detectPrompt(TRUST)?.kind).toBe('folder-trust');
  expect(detectPrompt(DECLARED)?.kind).toBe('declared-permissions');
  expect(detectPrompt(PICKER)?.kind).toBe('resume-picker');
});

test('an ordinary pane is not a menu, and a typed line starting with a digit does not fake one', () => {
  expect(detectPrompt(CALM)).toBeNull();
  expect(atInteractiveMenu('❯ 2 more files to review\n')).toBe(false);
});

test('a menu we do not recognise is still reported, never called idle', () => {
  const unknown = '\n ❯ 1. Something new\n   2. Other\n';
  expect(detectPrompt(unknown)?.kind).toBe('unrecognised');
});

test('trusting the directory is answered by default; the permissions a FILE declares are not', () => {
  const m = makeMachine();
  expect(m.trustPrompt).toBe('folder');
  expect(policyAnswers('folder-trust', m)).toBe(true);
  expect(policyAnswers('declared-permissions', m)).toBe(false);
  // Never guess at a menu whose options we cannot read.
  expect(policyAnswers('unrecognised', m)).toBe(false);
});

test('the escalated level accepts declared permissions, and off answers neither', () => {
  expect(policyAnswers('declared-permissions', makeMachine({ trustPrompt: 'declared' }))).toBe(
    true,
  );
  expect(policyAnswers('folder-trust', makeMachine({ trustPrompt: 'declared' }))).toBe(true);
  expect(policyAnswers('folder-trust', makeMachine({ trustPrompt: 'off' }))).toBe(false);
});

test('the first key is read from the pane, so a reordered menu still gets the right option', () => {
  const m = makeMachine();
  // Cursor already on "Yes": confirm. The fixture is the numbered rendering of the menu.
  expect(settleMenu(initialMenuSettle, TRUST, m).action).toEqual({ act: 'press', key: 'Enter' });
  const reordered = TRUST.replace(
    '❯ 1. Yes, I trust this folder\n   2. No, exit',
    '❯ 1. No, exit\n   2. Yes, I trust this folder',
  );
  // Cursor on "No": move toward "Yes", which is now below it.
  expect(settleMenu(initialMenuSettle, reordered, m).action).toEqual({ act: 'press', key: 'Down' });
});

test('the menu without numbers is answered too — the form the current client draws', () => {
  // Measured on a real client: no digits, cursor on either option. The number-based reader found no
  // answer in this form, and the session waited at the question indefinitely.
  const unnumbered = (cursorOnYes: boolean) => `
 Accessing workspace:
 /home/u/proj
 Security guide
 ${cursorOnYes ? ' ' : '❯'} No, exit
 ${cursorOnYes ? '❯' : ' '} Yes, I trust this folder
 Enter to confirm · Esc to cancel
`;
  const m = makeMachine();
  expect(settleMenu(initialMenuSettle, unnumbered(false), m).action).toEqual({
    act: 'press',
    key: 'Down',
  });
  expect(settleMenu(initialMenuSettle, unnumbered(true), m).action).toEqual({
    act: 'press',
    key: 'Enter',
  });
});

test('a declined prompt yields no key — the session waits rather than being answered for', () => {
  expect(settleMenu(initialMenuSettle, DECLARED, makeMachine()).action).toEqual({ act: 'wait' });
  expect(
    settleMenu(initialMenuSettle, DECLARED, makeMachine({ trustPrompt: 'declared' })).action,
  ).toEqual({ act: 'press', key: 'Enter' });
});

test('the pane scan carries the question, so the fleet can stop calling it idle', () => {
  expect(scanPane(TRUST).atPrompt).toBe('trust this folder');
  expect(scanPane(DECLARED).atPrompt).toBe('trust folder + permissions it declares');
  expect(scanPane(CALM).atPrompt).toBeNull();
});

test('a session at a menu reads as needing an answer, not as idle', () => {
  const idle = deriveStatus({ running: true, isWorking: false, lastMessage: null });
  expect(idle.key).not.toBe('prompt');

  const waiting = deriveStatus({
    running: true,
    isWorking: false,
    lastMessage: null,
    atPrompt: 'trust this folder',
  });
  expect(waiting.key).toBe('prompt');
  // The label carries the question: "needs something" is not actionable, "needs THIS" is.
  expect(waiting.label).toContain('trust this folder');
  expect(waiting.active).toBe(false);
});
