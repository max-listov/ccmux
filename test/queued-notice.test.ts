import { expect, test } from 'bun:test';
import { queuedForRetryNotice, relay } from '../src/fleet/transport.ts';

test("a failed hop whose message was queued says QUEUED, never 'nothing was sent'", () => {
  const n = queuedForRetryNotice('msg host-b:agent-b', 'ssh exited 255', 60);
  expect(n).toMatch(/QUEUED/);
  expect(n).not.toMatch(/nothing was sent/i);
  expect(n).toMatch(/retries it automatically/i);
  expect(n).toContain('60 minutes');
});

test('it tells the reader that no action is theirs — the point of the whole message', () => {
  // Two sessions read the old wording, decided their machine could only reach its peer through the
  // owner's forwarded key, and took a non-existent task to the owner. This sentence is the fix.
  expect(queuedForRetryNotice('msg x', null, 60)).toMatch(/Nothing is required of you/i);
});

test('a cause is reported only when the transport reported one', () => {
  // The old default guessed "no agent forwarding", which is what pointed both sessions at the
  // owner's laptop. Silence must read as silence.
  expect(queuedForRetryNotice('msg x', null, 60)).toContain('no reason');
  expect(queuedForRetryNotice('msg x', null, 60)).not.toMatch(/agent forwarding/i);
  expect(queuedForRetryNotice('msg x', 'connection refused', 60)).toContain('connection refused');
});

test('relay itself no longer invents a cause either', () => {
  const lines: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    relay({ code: 1, stdout: '', stderr: '', transportFailed: true }, 'restart x');
  } finally {
    console.error = err;
  }
  expect(lines.join('\n')).not.toMatch(/agent forwarding/i);
  expect(lines.join('\n')).toMatch(/no reason reported/i);
});
