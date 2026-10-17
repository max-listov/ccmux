import { expect, test } from 'bun:test';
import { settleMenu } from '../src/agent/claude/menuStep.ts';
import { initialMenuSettle, type MenuSettleState } from '../src/agent/menuSettle.ts';
import { makeMachine } from './helpers.ts';

// The supervisor answers a startup menu one key at a time, from what the pane shows. The defects
// this guards were all one shape — a key pressed into a pane that was no longer the menu the
// decision had been made for: 86 identical presses into ten sessions, and an Enter sent because "a
// menu" was still up, which on a menu with the cursor on "No, exit" is a refusal.

const TRUST_YES = 'Yes, I trust this folder';
const NO_EXIT = 'No, exit';

/** A pane that draws a menu the way Claude does and reacts to keys like one. */
class FakePane {
  cursor: number;
  gone = false;
  /** When set, a navigation key leaves the cursor where it is (the render has not happened yet). */
  frozen = false;
  /** When set, a navigation key moves the cursor by two, as a wrap or a jump would. */
  jump = false;
  constructor(
    public options: string[],
    cursor: number,
    public numbered = false,
    public header = 'Quick safety check: Is this a project you trust?',
  ) {
    this.cursor = cursor;
  }
  text(): string {
    if (this.gone) return '❯ \n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n';
    const lines = this.options.map(
      (o, i) => `${i === this.cursor ? '❯' : ' '} ${this.numbered ? `${i + 1}. ` : ''}${o}`,
    );
    return `\n ${this.header}\n Security guide\n${lines.join('\n')}\n Enter to confirm · Esc to cancel\n`;
  }
  press(key: string): void {
    if (key === 'Enter') this.gone = true;
    else if (key === 'Down' && !this.frozen) this.cursor += this.jump ? 2 : 1;
    else if (key === 'Up' && !this.frozen) this.cursor -= this.jump ? 2 : 1;
    else if (/^\d$/.test(key)) this.cursor = Number(key) - 1;
  }
}

function drive(
  pane: FakePane,
  m = makeMachine(),
  maxPolls = 12,
): { pressed: string[]; stopped: string | null } {
  const pressed: string[] = [];
  let state: MenuSettleState = initialMenuSettle;
  for (let i = 0; i < maxPolls; i++) {
    const step = settleMenu(state, pane.text(), m);
    state = step.state;
    if (step.action.act === 'stop') return { pressed, stopped: step.action.reason };
    if (step.action.act === 'press') {
      pressed.push(step.action.key);
      pane.press(step.action.key);
    }
  }
  return { pressed, stopped: null };
}

test('a trust menu with the cursor on "No, exit" is moved to "Yes" and only then confirmed', () => {
  // The defect: the cursor starts on the refusal, and a bare Enter selects it.
  const pane = new FakePane([NO_EXIT, TRUST_YES], 0);
  expect(drive(pane)).toEqual({ pressed: ['Down', 'Enter'], stopped: null });
  expect(pane.cursor).toBe(1);
});

test('the option is chosen by its text, not by where the cursor or the number happens to be', () => {
  expect(drive(new FakePane([TRUST_YES, NO_EXIT], 1, true)).pressed).toEqual(['Up', 'Enter']);
  expect(drive(new FakePane([NO_EXIT, TRUST_YES], 1)).pressed).toEqual(['Enter']);
  expect(drive(new FakePane([TRUST_YES, NO_EXIT], 0, true)).pressed).toEqual(['Enter']);
});

test('a navigation key that does not move the cursor ends the attempt — never an Enter', () => {
  const pane = new FakePane([NO_EXIT, TRUST_YES], 0);
  pane.frozen = true;
  const out = drive(pane);
  expect(out.pressed).toEqual(['Down']);
  expect(out.stopped).not.toBeNull();
});

test('a cursor that jumped is not a move one option toward the target', () => {
  const two = new FakePane([NO_EXIT, TRUST_YES], 0);
  two.jump = true;
  const out = drive(two);
  expect(out.pressed).toEqual(['Down']);
  expect(out.stopped).not.toBeNull();
});

test('a menu answered with Enter is never answered again while it still looks like a menu', () => {
  const pane = new FakePane([NO_EXIT, TRUST_YES], 1);
  const pressed: string[] = [];
  let state: MenuSettleState = initialMenuSettle;
  const m = makeMachine();
  for (let i = 0; i < 6; i++) {
    const step = settleMenu(state, pane.text(), m); // pane never clears: Enter did not register
    state = step.state;
    if (step.action.act === 'press') pressed.push(step.action.key);
    if (step.action.act === 'stop') break;
  }
  expect(pressed).toEqual(['Enter']);
});

test('a different menu after the answered one is answered on its own terms', () => {
  const m = makeMachine();
  const trust = new FakePane([NO_EXIT, TRUST_YES], 1);
  const first = settleMenu(initialMenuSettle, trust.text(), m);
  expect(first.action).toEqual({ act: 'press', key: 'Enter' });
  // The pane is seen with no menu between the two, which re-arms the rule.
  const between = settleMenu(first.state, 'composer\n', m);
  expect(between.state.armed).toBe(true);
  const picker = `
  ❯ 1. Resume from summary (recommended)
    2. Resume full session as-is
    3. Don't ask me again
  Enter to confirm · Esc to cancel`;
  expect(settleMenu(between.state, picker, m).action).toEqual({ act: 'press', key: '2' });
});

test('the picker: the number moves the cursor and Enter follows only once the cursor is on it', () => {
  const m = makeMachine({ resumePicker: 'full' });
  const text = (cursor: number) =>
    ['Resume from summary (recommended)', 'Resume full session as-is', "Don't ask me again"]
      .map((o, i) => `${i === cursor ? '❯' : ' '} ${i + 1}. ${o}`)
      .join('\n')
      .concat('\n Enter to confirm · Esc to cancel\n');
  const first = settleMenu(initialMenuSettle, text(0), m);
  expect(first.action).toEqual({ act: 'press', key: '2' });
  // Cursor still on 1: the number did not register, and Enter would confirm the WRONG option.
  expect(settleMenu(first.state, text(0), m).action.act).toBe('stop');
  // Cursor on 2: confirm.
  expect(settleMenu(first.state, text(1), m).action).toEqual({ act: 'press', key: 'Enter' });
  // Gone: the number alone was enough — no Enter into whatever replaced it.
  expect(settleMenu(first.state, 'composer\n', m).action).toEqual({ act: 'wait' });
});

test('the policy decides: a declined menu is never pressed', () => {
  expect(drive(new FakePane([NO_EXIT, TRUST_YES], 0), makeMachine({ trustPrompt: 'off' }))).toEqual(
    { pressed: [], stopped: null },
  );
  const declared = new FakePane(
    [NO_EXIT, TRUST_YES],
    0,
    false,
    'This folder pre-approves 2 tool permissions',
  );
  expect(drive(declared).pressed).toEqual([]);
  const permitted = new FakePane(
    [NO_EXIT, TRUST_YES],
    0,
    false,
    'This folder pre-approves 2 tool permissions',
  );
  expect(drive(permitted, makeMachine({ trustPrompt: 'declared' })).pressed).toEqual([
    'Down',
    'Enter',
  ]);
});

// Recorded from a real client: the folder-trust menu was refused ("No, exit"), the agent exited and
// was relaunched in the same pane, and its new menu was drawn beneath the old frame. Both footers
// are on the visible screen. (The path is replaced.)
const DOUBLED = `
 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel

────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /work/project

 Quick safety check: Is this a project you created or one you trust? (Like your
 own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

test('the menu drawn beneath an older frame of itself is the one answered', () => {
  const m = makeMachine();
  expect(settleMenu(initialMenuSettle, DOUBLED, m).action).toEqual({ act: 'press', key: 'Down' });
});

test('a frame with something drawn below it is not a menu to press keys into', () => {
  // The menu was left behind on screen and the agent's composer was drawn under it.
  const composerBelow = `${new FakePane([NO_EXIT, TRUST_YES], 0).text()}
────────────────────────────────────────
❯ 
────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;
  expect(settleMenu(initialMenuSettle, composerBelow, makeMachine()).action).toEqual({
    act: 'wait',
  });
});

test('a menu that changes while the cursor is being moved ends the attempt', () => {
  const m = makeMachine();
  const first = settleMenu(initialMenuSettle, new FakePane([NO_EXIT, TRUST_YES], 0).text(), m);
  expect(first.action).toEqual({ act: 'press', key: 'Down' });
  // The cursor is where it should be, but the question is a different one (new header).
  const other = new FakePane([NO_EXIT, TRUST_YES], 1, false, 'A different question entirely');
  expect(settleMenu(first.state, other.text(), m).action.act).toBe('stop');
  // And a menu that vanished after a navigation key is not waited out: the key may have landed in
  // whatever replaced it.
  expect(settleMenu(first.state, 'composer\n', m).action.act).toBe('stop');
});

test('the next menu is answered even when no empty frame was seen between them', () => {
  const m = makeMachine();
  const trust = settleMenu(initialMenuSettle, new FakePane([NO_EXIT, TRUST_YES], 1).text(), m);
  expect(trust.action).toEqual({ act: 'press', key: 'Enter' });
  const picker = `
  ❯ 1. Resume from summary (recommended)
    2. Resume full session as-is
    3. Don't ask me again
  Enter to confirm · Esc to cancel`;
  // The pane went straight from the trust menu to the picker: a different kind, a new question.
  expect(settleMenu(trust.state, picker, m).action).toEqual({ act: 'press', key: '2' });
  // The same kind still up is the old menu, and is not answered twice.
  expect(settleMenu(trust.state, new FakePane([NO_EXIT, TRUST_YES], 1).text(), m).action.act).toBe(
    'stop',
  );
});
