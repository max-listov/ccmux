import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nativeInputDelivered } from '../src/agent/claude/native/pickup.ts';
import { nativeTranscriptPath } from '../src/context/claude.ts';
import { RuntimeInputSchema } from '../src/runtime/input.ts';
import type { MachineConfig, Session } from '../src/types.ts';
import { makeMachine } from './helpers.ts';

/**
 * A dispatch cut short mid-flight. The phase file cannot answer whether the turn was sent — it
 * says only that the process died while sending — so the runtime's own transcript is asked, and
 * both wrong answers cost something: one drops a message nobody sent, the other sends a second
 * copy of one already answered.
 */

/** A profile is what the session declares in its env file; the process environment plays no part. */
function conversation(entries: unknown[]): { session: Session; dir: string; m: MachineConfig } {
  const home = mkdtempSync(join(tmpdir(), 'ccmux-dispatch-'));
  const dir = join(home, 'work');
  mkdirSync(dir, { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  const envFile = join(home, 'profile.env');
  writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${home}\n`);
  const session = {
    name: 'agent-A',
    dir,
    agent: 'claude',
    runtime: 'native',
    uuid: id,
    envFile,
    nativeSession: { id, kind: 'claude' },
  } as unknown as Session;
  const m = makeMachine({ projectsDir: join(home, 'machine-default', 'projects') });
  const path = nativeTranscriptPath(session, m);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return { dir, session, m };
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
  const { session, m } = conversation([
    {
      type: 'user',
      timestamp: '2026-09-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'ship the thing' }] },
    },
  ]);
  expect(nativeInputDelivered(m, session, input(), '2026-09-01T10:00:00.000Z')).toBe(true);
});

test('the same words sent before this dispatch are not its receipt', () => {
  const { session, m } = conversation([
    {
      type: 'user',
      timestamp: '2026-09-01T09:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'ship the thing' }] },
    },
  ]);
  // Matching on text alone would read an hour-old turn as an acknowledgement of this one and drop
  // a message that was never sent.
  expect(nativeInputDelivered(m, session, input(), '2026-09-01T10:00:00.000Z')).toBe(false);
});

test('a conversation with no such turn is undelivered, not unknown', () => {
  const { session, m } = conversation([
    {
      type: 'user',
      timestamp: '2026-09-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'something else' }] },
    },
  ]);
  expect(nativeInputDelivered(m, session, input(), '2026-09-01T10:00:00.000Z')).toBe(false);
});

test('a dispatch written before this field existed is judged by when its record was written', () => {
  const { session, m } = conversation([
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
    nativeInputDelivered(
      m,
      session,
      input({ dispatchedAt: undefined }),
      '2026-09-01T10:00:00.000Z',
    ),
  ).toBe(true);
});

test('an absent transcript means the turn never arrived', () => {
  const { session, m } = conversation([]);
  expect(nativeInputDelivered(m, session, input(), '2026-09-01T10:00:00.000Z')).toBe(false);
});
