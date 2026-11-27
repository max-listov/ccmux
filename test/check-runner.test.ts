import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortTempDir } from './helpers.ts';

test('the configured runner owns each independent gate or suite and preserves its exit status', () => {
  const root = join(import.meta.dir, '..');
  const runner = join(shortTempDir('stitchmux-check-'), 'runner');
  writeFileSync(
    runner,
    `#!${process.execPath}
console.log(JSON.stringify({args:process.argv.slice(2),nested:process.env.STITCHMUX_CHECK_RUNNING}));
process.exit(7);
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'stitchmux.checkRunner',
    GIT_CONFIG_VALUE_0: runner,
    STITCHMUX_CHECK_RUNNING: undefined,
  };
  for (const [entry, label, args] of [
    ['gate', 'stitchmux-gate', []],
    ['test-shards', 'stitchmux-tests', ['test/plan-limits.test.ts']],
    ['test-shards', 'stitchmux-tests-serial', ['--serial', 'test/plan-limits.test.ts']],
  ] as const) {
    const script = join(root, 'scripts', `${entry}.ts`);
    const result = Bun.spawnSync([process.execPath, script, ...args], { cwd: root, env });
    expect(result.exitCode, result.stderr.toString()).toBe(7);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      args: ['--project', 'stitchmux', '--label', label, '--', process.execPath, script, ...args],
      nested: '1',
    });
  }
  const nested = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      "import {enterCheckRunner} from './scripts/checkRunner.ts'; enterCheckRunner(process.cwd(),'stitchmux-tests'); console.log('nested suite ran');",
    ],
    {
      cwd: root,
      env: { ...env, STITCHMUX_CHECK_RUNNING: '1' },
    },
  );
  expect(nested.exitCode).toBe(0);
  expect(nested.stdout.toString().trim()).toBe('nested suite ran');
});
