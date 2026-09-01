import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nativeInputDelivered } from '../src/agent/claude/native/pickup.ts';
import { nativeTranscriptPath } from '../src/context/claude.ts';
import { RuntimeInputSchema } from '../src/runtime/input.ts';
import type { Session } from '../src/types.ts';

/**
 * A dispatch cut short mid-flight. The phase file cannot answer whether the turn was sent — it
 * says only that the process died while sending — so the runtime's own transcript is asked, and
 * both wrong answers cost something: one drops a message nobody sent, the other sends a second
 * copy of one already answered.
 */

const configDir = process.env.CLAUDE_CONFIG_DIR;
// Restored because this variable selects the conversation store for every test in the process, and
// a leaked one points a later test at a directory that stops existing when this file finishes.
afterAll(() => {
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
});

function conversation(entries: unknown[]): { session: Session; dir: string } {
  const home = mkdtempSync(join(tmpdir(), 'ccmux-dispatch-'));
  const dir = join(home, 'work');
  mkdirSync(dir, { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  process.env.CLAUDE_CONFIG_DIR = home;
  const session = {
    name: 'agent-A',
    dir,
    agent: 'claude',
    runtime: 'native',
    uuid: id,
    nativeSession: { id, kind: 'claude' },
  } as unknown as Session;
  const path = nativeTranscriptPath(session);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return { dir, session };
}

const input = (over: Record<string, unknown> = {}) =>
  RuntimeInputSchema.parse({
    messageId: '22222222-2222-4222-8222-222222222222',
    nativeId: 'msg_abc',
    text: 'ship the thing',
    phase: 'dispatching',
    dispatchedAt: '2026-09-01T10:00:00.000Z',
    ...over,
  });

test('a turn present in the transcript after its dispatch counts as delivered', () => {
  const { session } = conversation([
    {
      type: 'user',
      timestamp: '2026-09-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'ship the thing' }] },
    },
  ]);
  expect(nativeInputDelivered(session, input(), '2026-09-01T10:00:00.000Z')).toBe(true);
});

test('the same words sent before this dispatch are not its receipt', () => {
  const { session } = conversation([
    {
      type: 'user',
      timestamp: '2026-09-01T09:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'ship the thing' }] },
    },
  ]);
  // Matching on text alone would read an hour-old turn as an acknowledgement of this one and drop
  // a message that was never sent.
  expect(nativeInputDelivered(session, input(), '2026-09-01T10:00:00.000Z')).toBe(false);
});

test('a conversation with no such turn is undelivered, not unknown', () => {
  const { session } = conversation([
    {
      type: 'user',
      timestamp: '2026-09-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'something else' }] },
    },
  ]);
  expect(nativeInputDelivered(session, input(), '2026-09-01T10:00:00.000Z')).toBe(false);
});

test('a dispatch written before this field existed is judged by when its record was written', () => {
  const { session } = conversation([
    {
      type: 'user',
      timestamp: '2026-09-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'ship the thing' }] },
    },
  ]);
  // The whole population this reconciliation exists for is the turns an EARLIER build left in
  // flight, and none of them carries a dispatch time. Judging those undelivered would send every
  // one of them a second time — so the caller supplies the mailbox file's own timestamp, and the
  // answer is the same as for a record that carried it.
  expect(
    nativeInputDelivered(session, input({ dispatchedAt: undefined }), '2026-09-01T10:00:00.000Z'),
  ).toBe(true);
});

test('an absent transcript means the turn never arrived', () => {
  const { session } = conversation([]);
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ccmux-empty-'));
  expect(nativeInputDelivered(session, input(), '2026-09-01T10:00:00.000Z')).toBe(false);
});
