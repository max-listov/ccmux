import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { machineConfigPath } from '../src/config/location.ts';
import { CACHE_DIR, DATA_DIR, STATE_DIR } from '../src/config/paths.ts';

/**
 * The guard for `test/preload.ts`: if the preload stops running, every root below falls back to the
 * operator's home and the suite starts writing into it again — silently, because nothing a test
 * asserts depends on where its state lives. This is the test that notices.
 */
test('every ccmux root resolves inside the private test home, none inside the real one', () => {
  const home = process.env.CCMUX_TEST_HOME;
  expect(home).toBeDefined();
  for (const root of [STATE_DIR, CACHE_DIR, DATA_DIR, machineConfigPath()]) {
    expect(root.startsWith(`${home}/`)).toBe(true);
    expect(root.startsWith(`${homedir()}/`)).toBe(false);
  }
});

test('a child started without an explicit env lands in the same private home', async () => {
  // The case `process.env` alone does not cover: a child is handed the environment the process
  // started with unless the preload supplies the current one.
  const probe = [process.execPath, '-e', 'console.log(process.env.CCMUX_STATE_DIR ?? "MISSING")'];
  const async = Bun.spawn(probe, { stdout: 'pipe' });
  expect((await new Response(async.stdout).text()).trim()).toBe(STATE_DIR);
  expect(Bun.spawnSync({ cmd: probe }).stdout.toString().trim()).toBe(STATE_DIR);
});
