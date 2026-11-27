import { isAbsolute } from 'node:path';

/** Let the checkout's configured runner own the outer check, including its children and exit code. */
export function enterCheckRunner(
  root: string,
  label: 'stitchmux-gate' | 'stitchmux-tests' | 'stitchmux-tests-serial',
): void {
  if (process.env.STITCHMUX_CHECK_RUNNING === '1') return;
  const config = Bun.spawnSync(
    ['git', '-C', root, 'config', '--path', '--get', 'stitchmux.checkRunner'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (config.exitCode === 1) return;
  if (config.exitCode !== 0)
    throw new Error(`Cannot read stitchmux.checkRunner: ${config.stderr.toString().trim()}`);
  const runner = config.stdout.toString().trimEnd();
  if (!isAbsolute(runner))
    throw new Error('stitchmux.checkRunner must name an absolute executable');
  if (!process.execve) throw new Error('The configured check runner requires POSIX execve');
  process.execve(
    runner,
    [
      runner,
      '--project',
      'stitchmux',
      '--label',
      label,
      '--',
      process.execPath,
      ...process.argv.slice(1),
    ],
    {
      ...process.env,
      STITCHMUX_CHECK_RUNNING: '1',
    },
  );
}
