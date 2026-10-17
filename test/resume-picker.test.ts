import { expect, test } from 'bun:test';
import { settleMenu } from '../src/agent/claude/menuStep.ts';
import { initialMenuSettle } from '../src/agent/menuSettle.ts';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';

// A real, schema-valid config (no casts) — only `resumePicker` matters to the pure fn.
const base = MachineConfigSchema.parse({
  claudeBin: '/bin/claude',
  tmuxBin: '/bin/tmux',
  projectsDir: '/p',
  rcPrefix: 'test',
  stateDir: '/tmp',
  bootLabel: 'b',
});
const cfg = (resumePicker: 'full' | 'summary' | 'off') => ({ ...base, resumePicker });

/** The first key the supervisor would press for this pane, or null when it presses none. */
const answer = (pane: string, m: ReturnType<typeof cfg>): string | null => {
  const action = settleMenu(initialMenuSettle, pane, m).action;
  return action.act === 'press' ? action.key : null;
};

const PICKER = [
  '  This session is 10h 4m old and 196.1k tokens.',
  '  Resuming the full session will consume a substantial portion of your usage limits.',
  '  ❯ 1. Resume from summary (recommended)',
  '    2. Resume full session as-is',
  "    3. Don't ask me again",
].join('\n');

test('full policy → option 2 (keep all context)', () => {
  expect(answer(PICKER, cfg('full'))).toBe('2');
});

test('summary policy → option 1', () => {
  expect(answer(PICKER, cfg('summary'))).toBe('1');
});

test('off policy → never answers (a human will)', () => {
  expect(answer(PICKER, cfg('off'))).toBeNull();
});

test('no picker on screen → null', () => {
  expect(answer('just a normal prompt\n❯ ', cfg('full'))).toBeNull();
});

test('reordered menu → reads the ACTUAL option number, not a hardcoded one', () => {
  const reordered = [
    '  ❯ 1. Resume full session as-is',
    '    2. Resume from summary (recommended)',
    "    3. Don't ask me again",
  ].join('\n');
  // 'full' is now option 1 here — must return "1", proving it reads the pane, not a constant.
  expect(answer(reordered, cfg('full'))).toBe('1');
  expect(answer(reordered, cfg('summary'))).toBe('2');
});

test("both exact option labels required — a passing mention doesn't trigger", () => {
  // A conversation that merely says "resume from summary" must NOT be mistaken for the menu.
  expect(answer('we could resume from summary of the doc', cfg('full'))).toBeNull();
});
