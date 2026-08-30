import { createHash } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { readPrivate } from '../../attachments/files.ts';
import { withDirectoryLock } from '../../config/registryLock.ts';
import type { MachineConfig } from '../../types.ts';
import { privateRuntimeDirectory } from '../codex/ownedPaths.ts';

const EntrySchema = z
  .object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), data: z.string().max(64 * 1024 * 1024) })
  .strict();
export const CustomPackageSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    module: EntrySchema,
    darwinArm64: EntrySchema,
    darwinX64: EntrySchema,
  })
  .strict();
export type CustomPackage = z.infer<typeof CustomPackageSchema>;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const entries = (artifact: CustomPackage) => [
  { path: 'dist/runtime.js', entry: artifact.module },
  { path: 'native/darwin-arm64.node', entry: artifact.darwinArm64 },
  { path: 'native/darwin-x64.node', entry: artifact.darwinX64 },
];
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** The release's single verified JS artifact contains this immutable companion package.
 * Native loader-relative paths remain exactly those published by the engine package. No network,
 * dependency resolution, alternative source checkout or mutation of installed dependencies. */
export async function materializeCustomPackage(
  m: Pick<MachineConfig, 'stateDir'>,
  raw: CustomPackage,
): Promise<string> {
  const artifact = CustomPackageSchema.parse(raw);
  if (sha(JSON.stringify(entries(artifact).map(({ entry }) => entry.sha256))) !== artifact.digest)
    throw new Error('Custom packaged manifest digest differs');
  const packages = join(m.stateDir, 'runtime-packages');
  privateRuntimeDirectory(packages);
  const root = join(packages, artifact.digest);
  await withDirectoryLock(
    join(packages, `${artifact.digest}.lock`),
    async () => {
      let present = false;
      try {
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Custom package root is unsafe');
        present = true;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (!present) {
        const temp = join(packages, `${artifact.digest}.partial-${crypto.randomUUID()}`);
        await mkdir(temp, { mode: 0o700 });
        try {
          await mkdir(join(temp, 'dist'), { mode: 0o700 });
          await mkdir(join(temp, 'native'), { mode: 0o700 });
          for (const { path, entry } of entries(artifact)) {
            const bytes = gunzipSync(Buffer.from(entry.data, 'base64'), {
              maxOutputLength: MAX_FILE_BYTES,
            });
            if (sha(bytes) !== entry.sha256)
              throw new Error('Custom packaged file checksum differs');
            const file = await open(join(temp, path), 'wx', 0o600);
            try {
              await file.writeFile(bytes);
              await file.sync();
            } finally {
              await file.close();
            }
          }
          await rename(temp, root);
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
      privateRuntimeDirectory(root);
      privateRuntimeDirectory(join(root, 'dist'));
      privateRuntimeDirectory(join(root, 'native'));
      for (const { path, entry } of entries(artifact))
        if (sha(readPrivate(join(root, path), MAX_FILE_BYTES)) !== entry.sha256)
          throw new Error('Retained Custom package checksum differs');
    },
    'Custom runtime package',
  );
  return pathToFileURL(join(root, 'dist/runtime.js')).href;
}
