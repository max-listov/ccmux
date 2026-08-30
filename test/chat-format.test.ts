import { expect, test } from 'bun:test';
import { formatChatInjection } from '../src/chat/format.ts';
import type { ChatMessage } from '../src/types.ts';
import { makeChatMessage, makePeer } from './helpers.ts';

const base: ChatMessage = makeChatMessage({
  id: '1',
  ts: '2026-07-24T10:00:00.000Z',
  from: makePeer({ session: 'router' }),
  to: makePeer({ session: 'worker' }),
  body: 'do the thing',
});

test('plain peer message → [chat from <from>] body', () => {
  expect(formatChatInjection(base)).toBe(
    '[chat from ccmux/claude@host-a:router#11111111-1111-4111-8111-111111111111 · id: 1] do the thing',
  );
});

test('task is appended to the tag', () => {
  expect(formatChatInjection({ ...base, task: 'deploy' })).toBe(
    '[chat from ccmux/claude@host-a:router#11111111-1111-4111-8111-111111111111 · task: deploy · id: 1] do the thing',
  );
});

test('onBehalfOf renders honest provenance without spoofing from', () => {
  // from stays the true (unspoofable) courier; the recipient still sees the real authority.
  expect(formatChatInjection({ ...base, onBehalfOf: 'owner' })).toBe(
    '[chat from ccmux/claude@host-a:router#11111111-1111-4111-8111-111111111111 on behalf of owner · id: 1] do the thing',
  );
});

test('onBehalfOf + task combine in order', () => {
  expect(formatChatInjection({ ...base, onBehalfOf: 'owner', task: 'ship' })).toBe(
    '[chat from ccmux/claude@host-a:router#11111111-1111-4111-8111-111111111111 on behalf of owner · task: ship · id: 1] do the thing',
  );
});
