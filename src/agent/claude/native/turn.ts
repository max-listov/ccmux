import type { ExecutorDelta } from 'stitchkit/agent-executor';

/**
 * What the session is doing, derived from `stitchkit/agent-executor` deltas and operator controls.
 */

export type NativeState = 'working' | 'idle' | 'waiting-approval' | 'waiting-input';
export type TurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed';

export interface TurnState {
  status: TurnStatus | null;
  state: NativeState;
  /** Requests the operator has not answered. A turn is not idle while one is outstanding. */
  outstanding: number;
  /** Record types this driver did not recognise, kept so they surface instead of vanishing. */
  unhandled: readonly string[];
}

export const initialTurn: TurnState = {
  status: null,
  state: 'idle',
  outstanding: 0,
  unhandled: [],
};

export type TurnEvent =
  | { step: 'delta'; delta: ExecutorDelta }
  | { step: 'answered' }
  | { step: 'interrupted' }
  | { step: 'failed'; error: string };

const isRunning = (status: TurnStatus | null): boolean =>
  status === null || status === 'inProgress';

/** Advance turn state by one `ExecutorDelta` or lifecycle step. */
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
      state: outstanding > 0 ? current.state : isRunning(current.status) ? 'working' : 'idle',
    };
  }
  const { delta } = event;
  if (delta.type === 'error') {
    if (delta.kind !== 'unhandled') return current;
    const label = delta.raw.type;
    return {
      ...current,
      unhandled: current.unhandled.includes(label)
        ? current.unhandled
        : [...current.unhandled, label],
    };
  }
  if (delta.type === 'request') {
    const outstanding = current.outstanding + 1;
    return {
      ...current,
      outstanding,
      state: delta.kind === 'approval' ? 'waiting-approval' : 'waiting-input',
    };
  }
  if (delta.type === 'request-resolved') {
    const outstanding = Math.max(0, current.outstanding - 1);
    return {
      ...current,
      outstanding,
      state: outstanding > 0 ? current.state : isRunning(current.status) ? 'working' : 'idle',
    };
  }
  if (delta.type === 'turn-end') {
    return {
      ...current,
      status: isRunning(current.status) ? delta.outcome : current.status,
      state: current.outstanding > 0 ? current.state : 'idle',
    };
  }
  if (
    delta.type === 'text' ||
    delta.type === 'reasoning' ||
    delta.type === 'tool-call' ||
    delta.type === 'tool-result' ||
    delta.type === 'status'
  ) {
    return {
      ...current,
      status: isRunning(current.status) ? 'inProgress' : current.status,
      state: current.outstanding > 0 ? current.state : 'working',
    };
  }
  return current;
}
