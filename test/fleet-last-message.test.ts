import { expect, test } from 'bun:test';
import { RemoteSessionSchema } from '../src/commands/fleetList.ts';

/**
 * What a peer already knows and used to lose on the way.
 *
 * `list --json` reports the last transcript entry of every session it owns. The fleet slice parses
 * only the fields it names, so a field it did not name was dropped silently — the local machine's
 * sessions carried their last message and every remote one appeared to have said nothing, which
 * reads as a quiet fleet rather than as a schema that stopped listening.
 */

test('a peer session carries its last transcript entry through the fleet slice', () => {
  const row = RemoteSessionSchema.parse({
    name: 'agent-a',
    lastMessage: {
      kind: 'assistant',
      role: 'assistant',
      text: 'done',
      toolName: null,
      createdAt: '2026-09-01T10:00:00.000Z',
      // A newer peer may add fields; they travel rather than failing the parse.
      somethingNewer: 1,
    },
  });
  expect(row.lastMessage?.text).toBe('done');
  expect(row.lastMessage?.createdAt).toBe('2026-09-01T10:00:00.000Z');
  // A peer that reported none says none, which is not the same as an empty message.
  expect(RemoteSessionSchema.parse({ name: 'agent-b' }).lastMessage).toBeNull();
});
