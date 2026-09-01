import type { Classification } from './content.ts';

/**
 * What the session is doing, derived from the messages it has produced.
 *
 * The interactive mode infers this from a pane: a moving spinner means working, a still one might
 * mean idle or might mean a blank animation frame. Here the answer comes from the runtime's own
 * messages, so the states are facts rather than readings — which is the entire reason this execution
 * mode is worth having.
 *
 * Kept as a fold over classified messages so it can be exercised without a runtime: the sequences
 * that matter (a turn ending in a refusal, an approval outstanding when the stream stops, a result
 * arriving after an interrupt) are the ones that are awkward to produce on demand from a live one.
 */

export type NativeState = 'working' | 'idle' | 'waiting-approval' | 'waiting-input';
export type TurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed';

export interface TurnState {
  status: TurnStatus | null;
  state: NativeState;
  /** Requests the operator has not answered. A turn is not idle while one is outstanding. */
  outstanding: number;
  /** Members this build did not recognise, kept so they surface instead of vanishing. */
  unhandled: readonly string[];
}

export const initialTurn: TurnState = {
  status: null,
  state: 'idle',
  outstanding: 0,
  unhandled: [],
};

/**
 * Discriminated by a `step` tag rather than by which keys happen to be present.
 *
 * Presence checks looked tidy and were a trap: adding an optional `failed` flag to the message
 * variant made `'failed' in event` true for EVERY message, so every frame took the failure branch —
 * a live turn holding an unanswered permission reported itself failed and idle at once.
 */
export type TurnEvent =
  | {
      step: 'message';
      message: Classification;
      kind: 'approval' | 'input' | null;
      failed?: boolean;
    }
  | { step: 'answered' }
  | { step: 'interrupted' }
  | { step: 'failed'; error: string };

/**
 * Advance the state by one event.
 *
 * The rule that earns its place: a terminal message does NOT make the session idle while a request
 * is outstanding. The runtime can finish producing output and still be blocked on a permission
 * nobody has answered, and reporting that as idle is how a session sits waiting while every reader
 * believes it is free — the exact failure the interactive mode already has, which this mode exists
 * to remove.
 */
/** A turn that has not reached a terminal status is still running, whether or not it has one yet. */
const isRunning = (status: TurnStatus | null): boolean =>
  status === null || status === 'inProgress';

export function advanceTurn(current: TurnState, event: TurnEvent): TurnState {
  if (event.step === 'failed')
    return { ...current, status: 'failed', state: 'idle', outstanding: 0 };
  if (event.step === 'interrupted')
    return { ...current, status: 'interrupted', state: 'idle', outstanding: 0 };
  if (event.step === 'answered') {
    const outstanding = Math.max(0, current.outstanding - 1);
    return {
      ...current,
      outstanding,
      // Answering the last outstanding request returns the session to whatever the turn was doing:
      // still running if it has not ended, idle if it had already reached a terminal status. The
      // distinction is `inProgress` versus terminal, not "has a status at all" — treating an
      // in-progress turn as ended reported a working session as idle, which is precisely the lie
      // this execution mode exists to stop telling.
      state: outstanding > 0 ? current.state : isRunning(current.status) ? 'working' : 'idle',
    };
  }
  // Every other tag returned above; this is the message case and the compiler knows it.
  const { message, kind } = event;
  if ('unhandled' in message)
    return {
      ...current,
      unhandled: current.unhandled.includes(message.unhandled)
        ? current.unhandled
        : [...current.unhandled, message.unhandled],
    };
  if ('skip' in message) return current;
  if (kind !== null) {
    const outstanding = current.outstanding + 1;
    return {
      ...current,
      outstanding,
      state: kind === 'approval' ? 'waiting-approval' : 'waiting-input',
    };
  }
  if (message.kind === 'terminal')
    return {
      ...current,
      /**
       * A terminal message says the turn ENDED, not that it succeeded, and it must never overwrite a
       * status the turn already reached. An interrupted turn still receives its terminal message
       * afterwards; letting that write `completed` reported a cancellation as a normal finish, and a
       * caller acking on that status acked work nobody did.
       */
      status: isRunning(current.status)
        ? event.failed === true
          ? 'failed'
          : 'completed'
        : current.status,
      // A finished turn with an unanswered request is not idle, and saying so is the point.
      state: current.outstanding > 0 ? current.state : 'idle',
    };
  return {
    ...current,
    status:
      current.status === null || current.status === 'inProgress' ? 'inProgress' : current.status,
    state: current.outstanding > 0 ? current.state : 'working',
  };
}
