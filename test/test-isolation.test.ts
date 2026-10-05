import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('operator identity is absent in the test process and inherited child environments', async () => {
  const keys = [
    'CCMUX_SESSION',
    'CCMUX_CHAT_CREDENTIAL',
    'CCMUX_BOOTSTRAP_GENERATION',
    'CCMUX_RC_PREFIX',
  ];
  for (const key of keys) expect(process.env[key]).toBeUndefined();
  const probe = [
    process.execPath,
    '-e',
    `console.log(JSON.stringify(${JSON.stringify(keys)}.filter(key => process.env[key] !== undefined)))`,
  ];
  for (const env of [undefined, { ...process.env }]) {
    const child = Bun.spawn(probe, { ...(env ? { env } : {}), stdout: 'pipe', stderr: 'pipe' });
    expect((await new Response(child.stdout).text()).trim()).toBe('[]');
    expect(await child.exited).toBe(0);
    expect(
      Bun.spawnSync(probe, env ? { env } : {})
        .stdout.toString()
        .trim(),
    ).toBe('[]');
  }
});

test('a test run without the preload refuses to load ccmux paths instead of using the real ones', async () => {
  // `bun test` started outside the repository root never reads bunfig.toml, so the preload never
  // runs. Such a run once deleted the operator's installed app; the paths module now refuses it.
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-unpreloaded-'));
  try {
    const paths = join(import.meta.dir, '..', 'src', 'config', 'paths.ts');
    writeFileSync(
      join(dir, 'probe.test.ts'),
      `import { test } from 'bun:test';\ntest('probe', async () => { await import(${JSON.stringify(paths)}); });\n`,
    );
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: dir };
    const run = Bun.spawnSync({
      cmd: [process.execPath, 'test', 'probe.test.ts'],
      cwd: dir,
      env,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(run.exitCode).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain('without test/preload.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
