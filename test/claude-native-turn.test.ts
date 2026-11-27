import { expect, test } from 'bun:test';
import type { ExecutorDelta } from 'stitchkit/agent-executor';
import { advanceTurn, initialTurn, type TurnEvent } from '../src/agent/claude/native/turn.ts';

const raw = (type: string) => ({ source: 'claude', type });
const run = (events: readonly TurnEvent[]) => events.reduce(advanceTurn, initialTurn);

const textDelta = (): TurnEvent => ({
  step: 'delta',
  delta: { type: 'text', turnId: 't1', itemId: 'i1', text: 'hi', raw: raw('stream_event') },
});
const requestDelta = (kind: 'approval' | 'input' = 'approval'): TurnEvent => ({
  step: 'delta',
  delta: {
    type: 'request',
    turnId: 't1',
    itemId: 'req1',
    interactionId: 'int-1',
    kind,
    toolName: 'Bash',
    raw: raw('can_use_tool'),
  },
});
const endDelta = (outcome: 'completed' | 'failed' | 'interrupted' = 'completed'): TurnEvent => ({
  step: 'delta',
  delta: { type: 'turn-end', turnId: 't1', itemId: 'end', outcome, raw: raw('result') },
});
const unhandledDelta = (name: string): TurnEvent => ({
  step: 'delta',
  delta: {
    type: 'error',
    turnId: 't1',
    itemId: `err-${name}`,
    kind: 'unhandled',
    message: name,
    raw: raw(name),
  },
});

test('output makes the session working, and turn-end makes it idle', () => {
  expect(run([textDelta()])).toMatchObject({ state: 'working', status: 'inProgress' });
  expect(run([textDelta(), endDelta()])).toMatchObject({
    state: 'idle',
    status: 'completed',
  });
});

test('a finished turn with an unanswered request is NOT idle', () => {
  const state = run([textDelta(), requestDelta('approval'), endDelta('completed')]);
  expect(state).toMatchObject({ status: 'completed', state: 'waiting-approval', outstanding: 1 });
  expect(state.state).not.toBe('idle');
});

test('answering the last request releases the session, and only then', () => {
  const two = run([textDelta(), requestDelta('approval'), requestDelta('approval')]);
  expect(two.outstanding).toBe(2);
  const one = advanceTurn(two, { step: 'answered' });
  expect(one).toMatchObject({ outstanding: 1, state: 'waiting-approval' });
  const none = advanceTurn(one, { step: 'answered' });
  expect(none).toMatchObject({ outstanding: 0, state: 'working' });
});

test('answering after the turn already ended leaves it idle, not working', () => {
  const blocked = run([textDelta(), requestDelta('approval'), endDelta('completed')]);
  expect(advanceTurn(blocked, { step: 'answered' })).toMatchObject({
    outstanding: 0,
    state: 'idle',
    status: 'completed',
  });
});

test('an interrupt is a terminal state of its own, distinct from completion', () => {
  const state = advanceTurn(run([textDelta()]), { step: 'interrupted' });
  expect(state).toMatchObject({ status: 'interrupted', state: 'idle', outstanding: 0 });
});

test('an interrupt clears outstanding requests, because nobody will answer them now', () => {
  const blocked = run([textDelta(), requestDelta('approval')]);
  expect(advanceTurn(blocked, { step: 'interrupted' })).toMatchObject({
    outstanding: 0,
    state: 'idle',
  });
});

test('a failure is not a completion', () => {
  expect(advanceTurn(run([textDelta()]), { step: 'failed', error: 'transport' })).toMatchObject({
    status: 'failed',
    state: 'idle',
  });
});

test('unrecognised members are collected once each, and change nothing else', () => {
  const state = run([
    textDelta(),
    unhandledDelta('brand_new'),
    unhandledDelta('brand_new'),
    unhandledDelta('other_new'),
  ]);
  expect(state.unhandled).toEqual(['brand_new', 'other_new']);
  expect(state).toMatchObject({ state: 'working', status: 'inProgress' });
});

test('non-state deltas move nothing at all', () => {
  const before = run([textDelta()]);
  const usage: ExecutorDelta = {
    type: 'usage',
    turnId: 't1',
    itemId: 'u1',
    inputTokens: 10,
    raw: raw('result'),
  };
  const after = advanceTurn(before, { step: 'delta', delta: usage });
  expect(after).toEqual(before);
});

test('a terminal delta never overwrites a status the turn already reached', () => {
  const interrupted = advanceTurn(run([textDelta()]), { step: 'interrupted' });
  const after = advanceTurn(interrupted, endDelta('completed'));
  expect(after.status).toBe('interrupted');
});

test('a failed turn-end outcome marks the turn failed, not completed', () => {
  const failed = advanceTurn(run([textDelta()]), endDelta('failed'));
  expect(failed.status).toBe('failed');
});
