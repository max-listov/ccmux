import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortTempDir } from './helpers.ts';

test('the configured runner owns each independent gate or suite and preserves its exit status', () => {
  const root = join(import.meta.dir, '..');
  const runner = join(shortTempDir('ccmux-check-'), 'runner');
  writeFileSync(
    runner,
    `#!${process.execPath}
console.log(JSON.stringify({args:process.argv.slice(2),nested:process.env.CCMUX_CHECK_RUNNING}));
process.exit(7);
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'ccmux.checkRunner',
    GIT_CONFIG_VALUE_0: runner,
    CCMUX_CHECK_RUNNING: undefined,
  };
  for (const [entry, label, args] of [
    ['gate', 'ccmux-gate', []],
    ['test-shards', 'ccmux-tests', ['test/plan-limits.test.ts']],
    ['test-shards', 'ccmux-tests-serial', ['--serial', 'test/plan-limits.test.ts']],
  ] as const) {
    const script = join(root, 'scripts', `${entry}.ts`);
    const result = Bun.spawnSync([process.execPath, script, ...args], { cwd: root, env });
    expect(result.exitCode, result.stderr.toString()).toBe(7);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      args: ['--project', 'ccmux', '--label', label, '--', process.execPath, script, ...args],
      nested: '1',
    });
  }
  const nested = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      "import {enterCheckRunner} from './scripts/checkRunner.ts'; enterCheckRunner(process.cwd(),'ccmux-tests'); console.log('nested suite ran');",
    ],
    {
      cwd: root,
      env: { ...env, CCMUX_CHECK_RUNNING: '1' },
    },
  );
  expect(nested.exitCode).toBe(0);
  expect(nested.stdout.toString().trim()).toBe('nested suite ran');
});
