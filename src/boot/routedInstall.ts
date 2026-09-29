import { join } from 'node:path';
import { APP_DIR } from '../config/paths.ts';
import { convergePackagedFile, type PackagedFile, type PackagedInstall } from './packagedFile.ts';
import { ROUTED_ARTIFACTS } from './routedArtifacts.ts';
import { ROUTED_PROGRAMS } from './routedPrograms.ts';

/**
 * Require every routed program and install it beside the bundle.
 *
 * Convergent, like the shim and the boot unit next to it: a machine that is already correct comes
 * out untouched, and one carrying an older copy is rewritten. The digest is checked against the
 * bytes actually produced, so a truncated write or a half-finished rollout is replaced rather than
 * executed — these files run on every status refresh and every fleet read, and a broken one would
 * run thousands of times before anyone read a log. Returns the files it wrote.
 */
export async function ensureRoutedPrograms(
  artifacts: Readonly<Record<string, PackagedFile>> | null = ROUTED_ARTIFACTS,
  dir: string = APP_DIR,
): Promise<string[]> {
  if (artifacts === null) throw new Error('Required routed program artifacts are missing');
  const written: string[] = [];
  for (const program of ROUTED_PROGRAMS) {
    const artifact = artifacts[program.file];
    if (artifact === undefined) throw new Error(`Required ${program.file} artifact is missing`);
    const path = join(dir, program.file);
    const result: PackagedInstall = await convergePackagedFile(artifact, path, 0o755, program.file);
    if (result === 'written') written.push(path);
  }
  return written;
}
