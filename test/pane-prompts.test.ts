import { expect, test } from 'bun:test';
import { scanPane } from '../src/agent/claude/pane.ts';
import {
  atInteractiveMenu,
  detectPrompt,
  policyAnswers,
  promptAnswer,
} from '../src/agent/claude/prompts.ts';
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

test('the keystroke is read from the pane, so a reordered menu still gets the right option', () => {
  expect(promptAnswer(TRUST, makeMachine())).toBe('1');
  const reordered = TRUST.replace(
    '❯ 1. Yes, I trust this folder\n   2. No, exit',
    '❯ 1. No, exit\n   2. Yes, I trust this folder',
  );
  expect(promptAnswer(reordered, makeMachine())).toBe('2');
});

test('a declined prompt yields no keystroke — the session waits rather than being answered for', () => {
  expect(promptAnswer(DECLARED, makeMachine())).toBeNull();
  expect(promptAnswer(DECLARED, makeMachine({ trustPrompt: 'declared' }))).toBe('1');
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
