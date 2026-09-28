import type { PackagedFile } from './packagedFile.ts';

/**
 * Stitchkit's Darwin native backend, carried inside the bundle.
 *
 * Stitchkit reads a process's birth through it, and a lock records that birth so a pid reused after
 * a crash reboot is not mistaken for the writer that died. Its loader looks beside the code that
 * runs, and a single-file bundle has no `node_modules` beside it, so the bundle lays the backend down
 * itself. Null here on purpose: a source checkout loads it from `node_modules`. The release build
 * replaces this module with the real bytes.
 */
export interface NativeBackendArtifact {
  'darwin-arm64': PackagedFile;
  'darwin-x64': PackagedFile;
}

export const NATIVE_BACKEND_ARTIFACT: NativeBackendArtifact | null = null;
