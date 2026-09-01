import { expect, test } from 'bun:test';
import { classifySdkMessage } from '../src/agent/claude/native/content.ts';
import { advanceTurn, initialTurn, type TurnEvent } from '../src/agent/claude/native/turn.ts';

/** Replay a run the way the owner would, so the awkward sequences are exercised without a runtime. */
const run = (events: readonly TurnEvent[]) => events.reduce(advanceTurn, initialTurn);
const msg = (type: string, kind: 'approval' | 'input' | null = null): TurnEvent => ({
  step: 'message',
  message: classifySdkMessage(type),
  kind,
});

test('output makes the session working, and a result makes it idle', () => {
  expect(run([msg('assistant')])).toMatchObject({ state: 'working', status: 'inProgress' });
  expect(run([msg('assistant'), msg('result')])).toMatchObject({
    state: 'idle',
    status: 'completed',
  });
});

test('a finished turn with an unanswered request is NOT idle', () => {
  // The failure this exists to remove. The runtime can stop producing output while still blocked on
  // a permission nobody answered; calling that idle is how a session waits indefinitely while every
  // reader believes it is free — which is exactly what the interactive mode does today.
  const state = run([msg('assistant'), msg('user', 'approval'), msg('result')]);
  expect(state).toMatchObject({ status: 'completed', state: 'waiting-approval', outstanding: 1 });
  expect(state.state).not.toBe('idle');
});

test('answering the last request releases the session, and only then', () => {
  const two = run([msg('assistant'), msg('user', 'approval'), msg('user', 'approval')]);
  expect(two.outstanding).toBe(2);
  const one = advanceTurn(two, { step: 'answered' });
  expect(one).toMatchObject({ outstanding: 1, state: 'waiting-approval' });
  const none = advanceTurn(one, { step: 'answered' });
  // The turn had not ended, so the session goes back to working rather than to idle.
  expect(none).toMatchObject({ outstanding: 0, state: 'working' });
});

test('answering after the turn already ended leaves it idle, not working', () => {
  const blocked = run([msg('assistant'), msg('user', 'approval'), msg('result')]);
  expect(advanceTurn(blocked, { step: 'answered' })).toMatchObject({
    outstanding: 0,
    state: 'idle',
    status: 'completed',
  });
});

test('an interrupt is a terminal state of its own, distinct from completion', () => {
  const state = advanceTurn(run([msg('assistant')]), { step: 'interrupted' });
  expect(state).toMatchObject({ status: 'interrupted', state: 'idle', outstanding: 0 });
});

test('an interrupt clears outstanding requests, because nobody will answer them now', () => {
  const blocked = run([msg('assistant'), msg('user', 'approval')]);
  expect(advanceTurn(blocked, { step: 'interrupted' })).toMatchObject({
    outstanding: 0,
    state: 'idle',
  });
});

test('a failure is not a completion', () => {
  // Reporting a failed turn as completed would let a caller treat the absent answer as an answer.
  expect(
    advanceTurn(run([msg('assistant')]), { step: 'failed', error: 'transport' }),
  ).toMatchObject({
    status: 'failed',
    state: 'idle',
  });
});

test('a refusal ends the turn rather than leaving it running forever', () => {
  expect(run([msg('assistant'), msg('model_refusal_no_fallback')])).toMatchObject({
    status: 'completed',
    state: 'idle',
  });
});

test('unrecognised members are collected once each, and change nothing else', () => {
  const state = run([
    msg('assistant'),
    msg('brand_new'),
    msg('brand_new'),
    msg('compact_boundary'),
  ]);
  expect(state.unhandled).toEqual(['brand_new', 'compact_boundary']);
  // They are recorded, not acted on: an unknown member must not silently move the session's state.
  expect(state).toMatchObject({ state: 'working', status: 'inProgress' });
});

test('plumbing and diagnostics move nothing at all', () => {
  const before = run([msg('assistant')]);
  const after = run([msg('assistant'), msg('control_request'), msg('api_retry'), msg('system')]);
  expect(after).toEqual(before);
});

test('a message carrying a failure flag of false is not a failure', () => {
  // The trap this guards: the variants were once told apart by which keys were present, and adding
  // an optional `failed` flag to the message variant made `'failed' in event` true for EVERY
  // message. Every frame then took the failure branch, so a live turn holding an unanswered
  // permission published itself as failed AND idle at the same moment.
  const running = advanceTurn(initialTurn, {
    step: 'message',
    message: classifySdkMessage('assistant'),
    kind: null,
    failed: false,
  });
  expect(running).toMatchObject({ status: 'inProgress', state: 'working' });
});

test('a terminal message never overwrites a status the turn already reached', () => {
  // The runtime still emits its result after an interrupt. Letting that write `completed` reported a
  // cancellation as a normal finish, and a caller acking on the status acked work nobody did.
  const interrupted = advanceTurn(run([msg('assistant')]), { step: 'interrupted' });
  const after = advanceTurn(interrupted, {
    step: 'message',
    message: classifySdkMessage('result'),
    kind: null,
    failed: false,
  });
  expect(after.status).toBe('interrupted');
});

test('a result the runtime marks as an error is a failed turn, not a completed one', () => {
  const failed = advanceTurn(run([msg('assistant')]), {
    step: 'message',
    message: classifySdkMessage('result'),
    kind: null,
    failed: true,
  });
  expect(failed.status).toBe('failed');
});

test('a finished turn with an outstanding request keeps its waiting state', () => {
  // Published `idle` beside a non-empty pending list is the contradiction that sent a session to
  // wait forever while every reader believed it was free.
  const blocked = run([msg('assistant'), msg('user', 'approval')]);
  const ended = advanceTurn(blocked, {
    step: 'message',
    message: classifySdkMessage('result'),
    kind: null,
    failed: false,
  });
  expect(ended).toMatchObject({ state: 'waiting-approval', outstanding: 1 });
});
