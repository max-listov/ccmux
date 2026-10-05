import { createNativePackaging } from 'stitchkit/files/packaging';

export type UniversalNativePackaging = ReturnType<typeof requireUniversalNativePackaging>;

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

/**
 * Application-owned destinations. Stitchkit compares each addon with the digest it published and
 * hands back the verified `bytes`, so a packer embeds those bytes and their published `sha256`.
 * Packaging is read once per build: pass its result here instead of requiring it again.
 */
export function nativeCompanion(
  packaging: UniversalNativePackaging,
  architecture: 'arm64' | 'x64',
) {
  const asset = packaging.assets.find((candidate) => candidate.architecture === architecture);
  if (!asset) throw new Error(`Native companion ${architecture}: asset is absent`);
  return asset;
}
