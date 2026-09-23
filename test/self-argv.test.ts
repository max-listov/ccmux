import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { SELF_ARGV } from '../src/util/env.ts';

// The supervisor, the boot unit and every session's `_run` pane re-exec ccmux through this argv. In
// development it is `bun <entry>`, and the entry is found relative to this module — so moving the
// module without moving that answer leaves every restarted session unable to start.
test('the re-exec entry is a file that exists', () => {
  const entry = SELF_ARGV.at(-1);
  expect(entry).toBeDefined();
  expect(existsSync(entry as string)).toBe(true);
  expect(entry?.endsWith('cli.ts') || SELF_ARGV.length === 1).toBe(true);
});
