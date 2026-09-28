import { join } from 'node:path';
import { NATIVE_BACKEND_DIR } from '../config/paths.ts';
import { NATIVE_BACKEND_ARTIFACT, type NativeBackendArtifact } from './nativeBackendArtifact.ts';
import { convergePackagedFile, type PackagedInstall } from './packagedFile.ts';

/**
 * Install this machine's Darwin native backend where stitchkit's loader looks for it: `native/`
 * beside the bundle's directory. Without it every lock records an unknown process identity, and a
 * lock a crash left behind could then never be reclaimed. Other platforms need nothing.
 */
export async function ensureNativeBackend(
  artifact: NativeBackendArtifact | null = NATIVE_BACKEND_ARTIFACT,
  dir: string = NATIVE_BACKEND_DIR,
  platform: string = process.platform,
  arch: string = process.arch,
): Promise<PackagedInstall | 'not-needed'> {
  if (platform !== 'darwin') return 'not-needed';
  if (artifact === null) throw new Error('Required native backend artifact is missing');
  const binary = `darwin-${arch}`;
  if (binary !== 'darwin-arm64' && binary !== 'darwin-x64')
    throw new Error(`No native backend for ${binary}`);
  return convergePackagedFile(
    artifact[binary],
    join(dir, `${binary}.node`),
    0o644,
    'Native backend',
  );
}
