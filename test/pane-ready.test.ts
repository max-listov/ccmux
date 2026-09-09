import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanPane } from '../src/agent/claude/pane.ts';
import { resolveLiveState } from '../src/agent/sessionStatus.ts';
import { turnState } from '../src/chat/turnState.ts';

// Real captured chrome (ansi-stripped) from a booted claude pane — the ready marker is the
// permission-mode footer while idle, the interrupt hint while working. Both are claude-native and
// INDEPENDENT of the (user-defined) statusline, which is why the model no longer needs to be there.

const IDLE_PANE = [
  '⏺ done',
  '──────────────────────────────────── host-a-work ──',
  '❯ ',
  '   Fable 5 · 250.0k/1.0M 25%  sess ↓254.3k ↑1.3k',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

// The same pane after the agent left a background command running. Claude draws the footer as one
// line and puts the shell count WHERE THE HINT WAS — captured verbatim from a live session that had
// been up for two days and was reported "not painted yet".
const SHELLS_PANE = [
  '✻ Brewed for 4m 55s · 3 shells still running',
  '──────────────────────────────────── host-a-work ──',
  '❯ ',
  '   Opus 5 · 210.0k/1.0M 21%  sess ↓214.5k ↑796',
  '  ⏵⏵ bypass permissions on · 3 shells · ← for agents',
].join('\n');

const AUTO_MODE_PANE = ['❯ ', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n');

const DEFAULT_MODE_PANE = ['❯ ', '  ? for shortcuts'].join('\n');

const WORKING_PANE = ['✻ Transmuting…', '  (esc to interrupt)'].join('\n');

const BOOTING_PANE = ['', 'loading…', ''].join('\n');

test('a booted pane without a spinner is ready but indeterminate — even on a Fable statusline', () => {
  const scan = scanPane(IDLE_PANE);
  expect(scan.ready).toBe(true);
  expect(scan.state).toBe('indeterminate');
  expect(scan.context.percent).toBe(25); // context still read structurally
});

test('a working pane is ready and working', () => {
  const scan = scanPane(WORKING_PANE);
  expect(scan.ready).toBe(true);
  expect(scan.state).toBe('working');
});

test('a background shell does not un-draw the interface', () => {
  // The regression this file exists for. The hint is GONE from this footer — displaced by the shell
  // count — and the session was still fully interactive. Reading it as "not painted" held all of its
  // mail, timed out every `wait` on it, and printed `working` for a session sitting idle.
  const scan = scanPane(SHELLS_PANE);
  expect(scan.ready).toBe(true);
  expect(scan.state).toBe('indeterminate'); // completion marker is not a live spinner or a boundary
});

test('readiness survives on the mode footer alone, in every mode', () => {
  // Asserted per-mode rather than on one sample: the footer is the marker that cannot be displaced,
  // so if a mode's footer ever stops matching, that must fail HERE and not as lost mail.
  expect(scanPane(AUTO_MODE_PANE).ready).toBe(true);
  expect(scanPane(DEFAULT_MODE_PANE).ready).toBe(true);
});

test('a half-booted blank pane is NOT ready (waitReady keeps polling)', () => {
  // The other half of the fix: broadening the markers must not degrade into "always ready", which
  // would reintroduce the failure the not-drawn gate was built to prevent — a keystroke swallowed by
  // an unpainted UI, acked as delivered, never seen.
  expect(scanPane(BOOTING_PANE).ready).toBe(false);
});

test('PaneScan no longer carries a model field', () => {
  expect('model' in scanPane(IDLE_PANE)).toBe(false);
});

// The tail of a live pane whose bottom rows were taken by the queued-feedback-drafts box, captured
// twice by the session that reported it and identical both times. Kept as a file rather than a
// string literal: it is evidence, and retyping evidence is how it stops being evidence.
const DRAFTS_BOX_PANE = readFileSync(
  join(import.meta.dir, 'fixtures', 'claude-pane', 'queued-feedback-drafts.txt'),
  'utf8',
);

test('a box above the composer does not un-draw the interface', () => {
  // None of the four footer markers is in this capture — every one of them lives below the composer,
  // and this capture stops at the composer. The session was sitting at its prompt; reading it as
  // unpainted printed `working` for eleven hours and timed out every `wait` on it.
  const footer = /⏵+ [a-z ]+ on\b|\? for shortcuts|esc to interrupt|shift\+tab to cycle/;
  expect(footer.test(DRAFTS_BOX_PANE)).toBe(false);
  expect(scanPane(DRAFTS_BOX_PANE).ready).toBe(true);
});

test('an empty pane is still NOT ready, so the signal still refuses something', () => {
  // Captured from a live session that had not painted: twenty-four blank lines, no composer, no
  // markers. Without this the change would read as "always ready" and the not-drawn gate — which
  // exists to stop a keystroke being swallowed by an unpainted UI — would guard nothing.
  expect(scanPane('\n'.repeat(23)).ready).toBe(false);
  expect(scanPane(BOOTING_PANE).ready).toBe(false);
});

test('a `❯` in scrollback is not a composer', () => {
  // Claude prefixes past user messages with the same character, so the prompt alone cannot be the
  // signal: an old message would make a booting session look interactive.
  expect(scanPane(['❯ доделай sp-blocks', '', 'loading…'].join('\n')).ready).toBe(false);
});

test('with the box up, an abandoned turn mark is closed and the session reads idle', () => {
  // The whole chain the report followed, on the same capture: scan → facts → turn state → what
  // `list` prints. The pane is what decides `paneReady`, and it was the only false thing here — the
  // transcript had been still for eleven hours and the lifecycle mark was left behind by a hook.
  const scan = scanPane(DRAFTS_BOX_PANE);
  const facts = {
    paneWorking: scan.state === 'working',
    paneReady: scan.ready,
    atMenu: scan.atPrompt !== null,
    endedOnAssistantText: true,
    msSinceActivity: 11 * 60 * 60 * 1000,
  };
  const state = turnState(facts);
  expect(state).toEqual({ settled: true, why: 'turn-ended' });
  // `over` in the observation pass is exactly "a claimed turn plus a settled state", which is what
  // lets the abandoned mark be closed rather than carried for another eleven hours.
  expect(
    resolveLiveState(scan.state, { state: 'working', ts: 0, event: 'UserPromptSubmit' }, state),
  ).toBe('idle');
  // And the same facts with the OLD answer for the pane keep the session working, which is the bug.
  expect(
    resolveLiveState(
      scan.state,
      { state: 'working', ts: 0, event: 'UserPromptSubmit' },
      turnState({ ...facts, paneReady: false }),
    ),
  ).toBe('working');
});
