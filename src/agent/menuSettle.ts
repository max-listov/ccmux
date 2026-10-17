/** What an unattended answer to a blocking menu carries from one look at the pane to the next. */
/** What the last key sent is waiting to be confirmed by. */
export type MenuPending =
  | { kind: 'move'; fingerprint: string; expect: number }
  | { kind: 'number'; menu: string; number: string };

export interface MenuSettleState {
  /** False once a menu has been answered with Enter, until a pane with no menu is seen — or a
   *  different kind of menu, which is a new question rather than the old one still showing. */
  armed: boolean;
  /** The kind of menu last answered with Enter. */
  answered: string | null;
  pending: MenuPending | null;
}

export const initialMenuSettle: MenuSettleState = { armed: true, answered: null, pending: null };

export type MenuSettleAction =
  | { act: 'wait' }
  | { act: 'press'; key: string }
  | { act: 'stop'; reason: string };

export interface MenuSettleStep {
  state: MenuSettleState;
  action: MenuSettleAction;
}
