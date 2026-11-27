import { isAbsolute } from 'node:path';

/** Let the checkout's configured runner own the outer check, including its children and exit code. */
export function enterCheckRunner(
  root: string,
  label: 'ccmux-gate' | 'ccmux-tests' | 'ccmux-tests-serial',
): void {
  if (process.env.CCMUX_CHECK_RUNNING === '1') return;
  const config = Bun.spawnSync(
    ['git', '-C', root, 'config', '--path', '--get', 'ccmux.checkRunner'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (config.exitCode === 1) return;
  if (config.exitCode !== 0)
    throw new Error(`Cannot read ccmux.checkRunner: ${config.stderr.toString().trim()}`);
  const runner = config.stdout.toString().trimEnd();
  if (!isAbsolute(runner)) throw new Error('ccmux.checkRunner must name an absolute executable');
  if (!process.execve) throw new Error('The configured check runner requires POSIX execve');
  process.execve(
    runner,
    [
      runner,
      '--project',
      'ccmux',
      '--label',
      label,
      '--',
      process.execPath,
      ...process.argv.slice(1),
    ],
    {
      ...process.env,
      CCMUX_CHECK_RUNNING: '1',
    },
  );
}
