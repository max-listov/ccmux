import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mailBlocksSettle } from '../src/commands/wait.ts';
import type { ChatMessage } from '../src/types.ts';
import { makeChatMessage, makePeer } from './helpers.ts';

const src = (f: string): string => readFileSync(join(import.meta.dir, '..', 'src', f), 'utf8');

/**
 * `_run` shares a terminal with the agent it supervises, so a log line mirrored to stderr prints
 * into that agent's UI and lands in its input buffer — which then trips the "composer occupied"
 * delivery gate and silences the session's chat permanently, blaming a human who isn't there.
 * Proven live before the fix; these guard the shape of the fix rather than re-running a pty.
 */
test("_run silences the stderr log mirror — its stderr is the agent's terminal", () => {
  const s = src('commands/run.ts');
  expect(s).toContain('setStderrLogging(false)');
  // Before the supervisor loop, so nothing inside it can leak, and after argument validation, so a
  // hand-invoked `_run` still complains audibly.
  expect(s.indexOf('setStderrLogging(false)')).toBeLessThan(s.indexOf('for (;;)'));
  expect(s.indexOf('unknown session')).toBeLessThan(s.indexOf('setStderrLogging(false)'));
});

test('a failed spawn still says something in the pane — that is the one case nothing else would', () => {
  const s = src('commands/run.ts');
  expect(s).toContain('could not start');
  // A sentence, not a JSON record: the pane is a human surface.
  expect(s).not.toContain('console.error(JSON');
});

test('the TUI keeps its own mirror off for the same reason — one rule, two callers', () => {
  expect(src('tui/run.tsx')).toContain('setStderrLogging(false)');
});

test('wait treats undelivered mail as work that has not started — but only mail that can arrive', () => {
  // The recipe `msg` → `wait` → `transcript` raced itself: the daemon delivers a beat after `msg`
  // returns, so a `wait` fired immediately saw an idle pane and reported a turn that never began.
  // Asserted on behaviour, not on the shape of a source line — the previous version of this test
  // pinned the exact expression and broke the moment the call was refactored, proving nothing.
  const at = Date.parse('2026-08-05T12:00:00.000Z');
  const msg = (over: Partial<ChatMessage> = {}): ChatMessage =>
    makeChatMessage({
      id: 'm',
      ts: '2026-08-05T11:59:00.000Z',
      from: makePeer({ session: 'a' }),
      to: makePeer({ session: 'b' }),
      body: 'x',
      defer: true,
      ...over,
    });
  const on = { chatEnabled: true, canReceiveChat: true, nowMs: at };
  expect(mailBlocksSettle([msg()], on)).toHaveLength(1);
  // A watchdog armed for later must not make `wait` useless until it fires.
  expect(mailBlocksSettle([msg({ notBefore: '2026-08-05T12:10:00.000Z' })], on)).toHaveLength(0);
  // Mail that can never be delivered (chat off / an agent that cannot receive it) is not "pending
  // work" — waiting on it is waiting forever, which `holdReason` already calls permanent.
  expect(mailBlocksSettle([msg()], { ...on, chatEnabled: false })).toHaveLength(0);
  expect(mailBlocksSettle([msg()], { ...on, canReceiveChat: false })).toHaveLength(0);
});
