import { expect, test } from 'bun:test';
import { LOG_FILE, STATE_DIR } from '../src/config/paths.ts';
import { IS_DEV } from '../src/env.ts';

test('a checkout writes its own record, and never into the machine history', () => {
  // The suite itself runs from a checkout, so this test IS the case being guarded: without the
  // split, every one of these records lands in the file an operator reads to answer "what happened
  // on this machine". Measured before the split on a developer's machine: 16_199 of 18_724 records
  // came from checkout runs — 86.5% of the file, and any count taken from it answered about the
  // wrong population.
  expect(IS_DEV).toBe(true);
  expect(LOG_FILE.endsWith('ccmux.dev.log')).toBe(true);
  expect(LOG_FILE).not.toBe(`${STATE_DIR}/ccmux.log`);

  // State is deliberately NOT split. A checkout run must see the real registry, sessions and locks,
  // or it would be answering about a machine that does not exist. Only the narrative separates.
  expect(LOG_FILE.startsWith(STATE_DIR)).toBe(true);
});
