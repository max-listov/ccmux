import { expect, test } from 'bun:test';
import type { NativePendingRequest } from '../src/runtime/projectionSchema.ts';
import { type NativeResponseCommand, nativeResponseRefusal } from '../src/runtime/response.ts';

const generation = crypto.randomUUID();

function command(patch: Partial<NativeResponseCommand>): NativeResponseCommand {
  return {
    operationId: crypto.randomUUID(),
    generation,
    requestId: 'r1',
    fingerprint: 'f'.repeat(64),
    kind: 'input',
    decision: null,
    answers: { q: ['A'] },
    ...patch,
  };
}

function request(
  question: Partial<NativePendingRequest['questions'][number]>,
): NativePendingRequest {
  return {
    requestId: 'r1',
    rpcId: 1,
    kind: 'input',
    approvalKind: null,
    turnId: 't',
    itemId: 'i',
    reason: null,
    scope: null,
    decisions: [],
    questions: [
      {
        id: 'q',
        header: '',
        question: '',
        isOther: false,
        isSecret: false,
        options: [{ label: 'A', description: '' }],
        ...question,
      },
    ],
    requestedAt: new Date().toISOString(),
  };
}

test('an answer is checked against what the request offers, not only against its shape', () => {
  expect(nativeResponseRefusal(command({}), request({}), generation)).toBeNull();
  expect(nativeResponseRefusal(command({ answers: { q: ['B'] } }), request({}), generation)).toBe(
    'answer-is-not-available',
  );
  // A question that accepts its own answer, or offers no menu, takes any text.
  expect(
    nativeResponseRefusal(
      command({ answers: { q: ['B'] } }),
      request({ isOther: true }),
      generation,
    ),
  ).toBeNull();
  expect(
    nativeResponseRefusal(
      command({ answers: { q: ['B'] } }),
      request({ options: null }),
      generation,
    ),
  ).toBeNull();
});

test('only a request that declared one answer is held to one', () => {
  const two = command({ answers: { q: ['A', 'A'] } });
  expect(nativeResponseRefusal(two, request({ multiple: false }), generation)).toBe(
    'answer-is-not-available',
  );
  expect(nativeResponseRefusal(two, request({}), generation)).toBeNull();
});

test('each way a response misses its request is named', () => {
  const approval = { ...request({}), kind: 'approval' as const, decisions: ['accept' as const] };
  expect(
    nativeResponseRefusal(command({ generation: crypto.randomUUID() }), request({}), generation),
  ).toBe('projection-generation-mismatch');
  expect(nativeResponseRefusal(command({}), null, generation)).toBe('request-is-not-pending');
  expect(nativeResponseRefusal(command({}), approval, generation)).toBe('request-kind-mismatch');
  expect(
    nativeResponseRefusal(command({ kind: 'approval', decision: 'decline' }), approval, generation),
  ).toBe('decision-is-not-available');
  expect(
    nativeResponseRefusal(command({ kind: 'approval', decision: 'accept' }), approval, generation),
  ).toBeNull();
  expect(nativeResponseRefusal(command({ answers: null }), request({}), generation)).toBe(
    'answers-are-required',
  );
  expect(
    nativeResponseRefusal(command({ answers: { other: ['A'] } }), request({}), generation),
  ).toBe('question-id-mismatch');
});
