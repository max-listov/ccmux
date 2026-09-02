import { expect, test } from 'bun:test';
import { spawnFailureReason } from '../src/commands/run.ts';

const enoent = new Error(
  "ENOENT: no such file or directory, posix_spawn '/root/.local/bin/claude'",
);

test('a missing working directory is named, not the executable it blamed', () => {
  // This is what the system says, and it is about the wrong thing: the binary at that path exists,
  // is executable and runs by hand. `posix_spawn` reports an absent cwd as ENOENT naming the
  // executable, so the message sends whoever reads it to check a file that is fine.
  const reason = spawnFailureReason(enoent, 'agent-a', '/home/u/gone', false);
  expect(reason).toContain('/home/u/gone');
  expect(reason).not.toContain('posix_spawn');
  // And it says what to do about it, because the fix is one command and the reader should not have
  // to go looking for which.
  expect(reason).toContain('ccmux dir agent-a');
});

test('the same error keeps its own text when the directory is there', () => {
  // Then ENOENT is about something else — a missing interpreter, a deleted binary — and inventing
  // a directory explanation would be a confident wrong cause, which is worse than repeating what
  // the system said.
  expect(spawnFailureReason(enoent, 'agent-a', '/home/u/present', true)).toBe(String(enoent));
});

test('a failure that is not ENOENT is never reinterpreted', () => {
  const denied = new Error("EACCES: permission denied, posix_spawn '/root/.local/bin/claude'");
  // Even with the directory genuinely gone: this failure is not the one being explained, and only
  // the case that was measured gets a new sentence.
  expect(spawnFailureReason(denied, 'agent-a', '/home/u/gone', false)).toBe(String(denied));
});
