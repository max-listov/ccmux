import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Deterministic archive of the exact release commit, including the native implementation. */
export function packageSource(outputDirectory: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid source package version');
  const root = resolve(import.meta.dir, '..');
  mkdirSync(outputDirectory, { recursive: true });
  const archive = join(outputDirectory, `ccmux-${version}.tgz`);
  const result = Bun.spawnSync(
    [
      'git',
      '-C',
      root,
      'archive',
      '--format=tar.gz',
      '--prefix=package/',
      `--output=${archive}`,
      'HEAD',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) throw Error(result.stderr.toString());
  return archive;
}
if (import.meta.main) {
  const [outputDirectory, version] = Bun.argv.slice(2);
  if (!outputDirectory || !version) throw Error('package-source <output-directory> <version>');
  console.log(packageSource(resolve(outputDirectory), version));
}
