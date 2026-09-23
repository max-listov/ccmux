import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every test runs against a private ccmux home, never the operator's.
 *
 * `src/config/paths.ts` resolves its roots once, at import, from the environment — and before this a
 * test that did not set them itself resolved to the real ones. Measured when this was added: one test
 * file left 24 index files in the operator's cache, 3137 indexes of transcripts that no longer existed
 * had piled up there (575 MB), and the daemon's log held thousands of lines of test traffic, fake
 * warnings included — in the file an operator reads to find real ones.
 *
 * Set unconditionally, before any test module is loaded: a variable already in the shell (an isolated
 * instance of someone's own) is exactly as wrong a place for tests to write. A test that needs its
 * own root still sets it.
 *
 * Children are the half that setting `process.env` does not reach. `Bun.spawn` and `Bun.spawnSync`
 * without an explicit `env` hand a child the environment the process STARTED with, not the one it
 * has now (measured: a variable assigned here arrived in a child as missing; libc `setenv` does not
 * help, Bun keeps its own copy). So those two default to the current `process.env` for the length of
 * the suite; a call that passes its own `env` is untouched. `Bun.$` already inherits the current one.
 */
// Each root ends in the tool's own directory, as it does on a real machine: code and tests may rely on it.
const root = mkdtempSync(join(tmpdir(), 'ccmux-test-home-'));
process.env.CCMUX_STATE_DIR = join(root, 'state', 'ccmux');
process.env.CCMUX_CACHE_DIR = join(root, 'cache', 'ccmux');
process.env.CCMUX_DATA_DIR = join(root, 'data', 'ccmux');
process.env.CCMUX_CONFIG = join(root, 'config', 'ccmux', 'machine.json');
process.env.CCMUX_TEST_HOME = root;
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

/** The call's arguments with `env: process.env` as the default, in either of the two call shapes. */
function withEnv(first: unknown, second?: unknown): unknown[] {
  if (Array.isArray(first)) return [first, { env: process.env, ...(second as object | undefined) }];
  return [{ env: process.env, ...(first as object) }, second];
}
const spawn = Bun.spawn as (...args: unknown[]) => unknown;
const spawnSync = Bun.spawnSync as (...args: unknown[]) => unknown;
Bun.spawn = ((first: unknown, second?: unknown) =>
  spawn(...withEnv(first, second))) as typeof Bun.spawn;
Bun.spawnSync = ((first: unknown, second?: unknown) =>
  spawnSync(...withEnv(first, second))) as typeof Bun.spawnSync;
