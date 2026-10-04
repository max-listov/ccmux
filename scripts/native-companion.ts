import { createNativePackaging } from 'stitchkit/files/packaging';

/** One JS graph carries both Darwin targets; Linux keeps its lazy portable backend. */
export function requireUniversalNativePackaging(entryPath: string) {
  const packaging = createNativePackaging({
    platform: 'darwin',
    architecture: ['arm64', 'x64'],
    delivery: 'companion',
    entryPath,
    assetPath: { arm64: 'native/darwin-arm64.node', x64: 'native/darwin-x64.node' },
  });
  if (packaging.state !== 'ready') throw new Error(`Native companions: ${packaging.code}`);
  return packaging;
}

/** Application-owned destinations; source paths and integrity belong to Stitchkit. */
export function requireNativeCompanion(architecture: 'arm64' | 'x64', entryPath: string) {
  const asset = requireUniversalNativePackaging(entryPath).assets.find(
    (candidate) => candidate.architecture === architecture,
  );
  if (!asset) throw new Error(`Native companion ${architecture}: asset is absent`);
  return asset;
}
