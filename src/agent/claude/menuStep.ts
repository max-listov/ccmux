import { createHash } from 'node:crypto';
import type { MachineConfig } from '../../types.ts';
import { initialMenuSettle, type MenuSettleState, type MenuSettleStep } from '../menuSettle.ts';
import {
  liveFrame,
  PICKER_FULL,
  PICKER_SUMMARY,
  paneTail,
  policyAnswers,
  TRUST_YES,
  terminalMenu,
} from './prompts.ts';

/**
 * Answering one of Claude's blocking menus, one key at a time.
 *
 * Both callers that move a menu's cursor — the supervisor's unattended answer on startup and the
 * `terminal.respond` operation a person or agent drives — go through the rules here, so there is a
 * single statement of when a key may be pressed. The rules exist because a keystroke sent to a pane
 * that is no longer a menu is never harmless: it is an `Up` that recalls an old prompt into the
 * composer, or an Enter that submits a turn nobody wrote, and an occupied composer holds every
 * message addressed to that session.
 *
 *  - The target is chosen by its TEXT, and the cursor by where the pane draws it. Neither position
 *    nor numbering is assumed: the same trust menu has been seen with its cursor on either option.
 *  - Movement is one key, then the pane must show the cursor exactly one option nearer the target.
 *    A jump, a wrap, a changed menu or no change at all ends the attempt.
 *  - `Enter` is pressed only on a snapshot that shows the cursor on the target, and a menu answered
 *    with `Enter` is never answered again until the pane has been seen with no menu on it.
 */

/** The identity of a menu's contents without the cursor, so the same menu with the cursor moved is
 *  recognisably the same menu and a different menu is not. */
export function menuFingerprint(paneText: string): string {
  return createHash('sha256')
    .update(
      paneTail(paneText, 40)
        .replaceAll('❯', ' ')
        .split('\n')
        .map((l) => l.trim())
        .join('\n'),
    )
    .digest('hex');
}

export type NavigationKey = 'Enter' | 'Down' | 'Up';

/** The one key that moves a cursor at `selected` toward `desired`. */
export function navigationKey(selected: number, desired: number): NavigationKey {
  return desired === selected ? 'Enter' : desired > selected ? 'Down' : 'Up';
}

/** The cursor position a single navigation key must produce. */
export function expectedSelection(selected: number, key: 'Down' | 'Up'): number {
  return key === 'Down' ? selected + 1 : selected - 1;
}

const CURSOR_NUMBER_RE = /❯\s*(\d+)\.\s/;
/** The option number under the cursor in a numbered menu, or null. */
export function cursorNumber(paneText: string): string | null {
  return paneTail(paneText, 40).match(CURSOR_NUMBER_RE)?.[1] ?? null;
}

function optionNumber(tail: string, label: string): string | null {
  return tail.match(new RegExp(String.raw`(\d+)\.\s*${label}`))?.[1] ?? null;
}

/**
 * The next step for the menu the pane shows now, given what was pressed before. Pure: the caller
 * captures the visible screen, sends the key and waits for it to render.
 */
export function settleMenu(
  state: MenuSettleState,
  paneText: string,
  m: MachineConfig,
): MenuSettleStep {
  // Only the frame at the bottom of the screen is the question being asked; a frame drawn over, or
  // one with something beneath it, is not one to press keys into.
  const frame = liveFrame(paneText);
  const menu = frame === null ? null : terminalMenu(frame);
  if (menu === null) {
    // A navigation key was pressed and the menu is gone: the key may have gone into whatever
    // replaced it, which is not something to keep guessing at. A number key may legitimately have
    // selected and closed the menu, and nothing was pressed after it.
    if (state.pending?.kind === 'move')
      return stop(state, 'the menu disappeared after a navigation key');
    // Otherwise whatever was pressed has cleared, so a menu appearing later is a different one.
    return { state: initialMenuSettle, action: { act: 'wait' } };
  }
  const shown = frame ?? '';
  let { armed, pending } = state;
  // A different kind of menu than the one answered with Enter is the next question (trust, then the
  // resume picker), even when the pane never showed an empty frame between them.
  if (!armed && state.answered !== null && menu.kind !== state.answered) armed = true;

  if (pending?.kind === 'move') {
    if (menu.selected === pending.expect && menuFingerprint(shown) === pending.fingerprint)
      pending = null;
    else
      return stop(
        state,
        'a navigation key did not move the cursor one option toward the target, or the menu changed',
      );
  } else if (pending?.kind === 'number') {
    if (menu.kind !== pending.menu) {
      // A different menu followed the one answered (trust, then the resume picker): the earlier
      // answer was taken, and this one is decided on its own.
      armed = true;
      pending = null;
    } else if (cursorNumber(shown) === pending.number)
      return {
        state: { armed: false, answered: menu.kind, pending: null },
        action: { act: 'press', key: 'Enter' },
      };
    else return stop(state, 'a number key did not put the cursor on the chosen option');
  }

  // Answered with Enter and the same menu is still up: by now it may be a live composer.
  if (!armed) return stop(state, 'the menu answered a moment ago is still up');
  if (!policyAnswers(menu.kind, m)) return wait(armed, state);

  if (menu.kind === 'folder-trust' || menu.kind === 'declared-permissions') {
    const target = menu.options.findIndex((o) => o.label === TRUST_YES);
    if (target < 0 || menu.selected === null) return wait(armed, state);
    const key = navigationKey(menu.selected, target);
    if (key === 'Enter')
      return {
        state: { armed: false, answered: menu.kind, pending: null },
        action: { act: 'press', key },
      };
    return {
      state: {
        armed,
        answered: state.answered,
        pending: {
          kind: 'move',
          fingerprint: menuFingerprint(shown),
          expect: expectedSelection(menu.selected, key),
        },
      },
      action: { act: 'press', key },
    };
  }

  if (menu.kind === 'resume-picker') {
    const tail = paneTail(shown, 40);
    const number = optionNumber(tail, m.resumePicker === 'summary' ? PICKER_SUMMARY : PICKER_FULL);
    if (number === null) return wait(armed, state);
    return {
      state: {
        armed,
        answered: state.answered,
        pending: { kind: 'number', menu: menu.kind, number },
      },
      action: { act: 'press', key: number },
    };
  }
  return wait(armed, state);
}

const wait = (armed: boolean, state: MenuSettleState): MenuSettleStep => ({
  state: { armed, answered: state.answered, pending: null },
  action: { act: 'wait' },
});

const stop = (state: MenuSettleState, reason: string): MenuSettleStep => ({
  state: { armed: false, answered: state.answered, pending: state.pending },
  action: { act: 'stop', reason },
});
