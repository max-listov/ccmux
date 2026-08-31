import { expect, test } from 'bun:test';
import { settleStep } from '../src/commands/run.ts';

// Recorded by the daemon over four days before this rule existed: 86 keystrokes, every one the same
// key, across ten sessions, up to eight into one of them about 1.5 seconds apart. Five composers
// were later found holding that character — an occupied composer holds every message addressed to
// its session — and two sessions received it as a user turn nobody wrote.

/** Drive the rule the way the loop does: a sequence of what the pane showed on each poll. */
function run(polls: readonly (string | null)[]): { pressed: string[]; stopped: boolean } {
  const pressed: string[] = [];
  let armed = true;
  for (const key of polls) {
    const decision = settleStep(key, armed);
    armed = decision.armed;
    if (decision.step === 'stop') return { pressed, stopped: true };
    if (decision.step === 'answer') pressed.push(decision.key);
  }
  return { pressed, stopped: false };
}

test('a menu is answered once, however long it keeps looking like a menu', () => {
  // The defect, as a sequence: the pane went on matching and the old loop went on pressing.
  expect(run(['2', '2', '2', '2', '2', '2', '2', '2'])).toEqual({
    pressed: ['2'],
    stopped: true,
  });
});

test('an answer that does not clear ends the watch instead of guessing again', () => {
  // By the second look the supervisor cannot tell a live menu from a composer that has already
  // received the first press. Stopping is what it can honestly justify; a stranded session is
  // visible to `doctor` and to a person, and a typed character in a live conversation is not.
  const { pressed, stopped } = run(['2', '2']);
  expect(pressed).toEqual(['2']);
  expect(stopped).toBe(true);
});

test('two menus in a row are both answered — the case the loop exists for', () => {
  // Startup can raise folder trust and then the resume picker. Seeing the pane clear between them
  // is the evidence that the second menu is a different one rather than the first one again.
  expect(run(['1', null, '2'])).toEqual({ pressed: ['1', '2'], stopped: false });
});

test('a pane that never shows a menu is never pressed', () => {
  expect(run([null, null, null])).toEqual({ pressed: [], stopped: false });
});

test('the arming is spent by answering and restored only by a clear pane', () => {
  expect(settleStep('2', true)).toEqual({ step: 'answer', armed: false, key: '2' });
  expect(settleStep('2', false)).toEqual({ step: 'stop', armed: false });
  expect(settleStep(null, false)).toEqual({ step: 'wait', armed: true });
  expect(settleStep(null, true)).toEqual({ step: 'wait', armed: true });
});

test('the key the caller sends is the one the rule authorised', () => {
  // The decision carries it, so a caller cannot press a key the rule did not agree to — which is
  // how a stale value from a previous poll would reach the pane.
  const decision = settleStep('3', true);
  expect(decision.step === 'answer' && decision.key).toBe('3');
});
