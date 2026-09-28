import { STATUS_LINE_APP } from '../config/paths.ts';
import { convergePackagedFile, type PackagedFile, type PackagedInstall } from './packagedFile.ts';
import { STATUS_LINE_ARTIFACT } from './statusLineArtifact.ts';

/**
 * Require the packaged status-line program and install it beside the bundle.
 *
 * Convergent, like the shim and the boot unit next to it: a machine that is already correct comes
 * out untouched, and one carrying an older copy is rewritten. The digest is checked against the
 * bytes actually produced, so a truncated write or a half-finished rollout is replaced rather than
 * executed — this file is run on every status refresh, and a broken one would be run thousands of
 * times before anyone read a log.
 */
export async function ensureStatusLineApp(
  artifact: PackagedFile | null = STATUS_LINE_ARTIFACT,
  path: string = STATUS_LINE_APP,
): Promise<PackagedInstall> {
  if (artifact === null) throw new Error('Required status-line artifact is missing');
  return convergePackagedFile(artifact, path, 0o755, 'Status-line');
}
