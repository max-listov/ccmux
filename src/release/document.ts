import { type CliBuildManifest, signCliManifest } from 'stitchkit/cli';

/** The targets one bundle is published for. It is JavaScript run by Bun, so every target names the
 *  same file; a machine on a target not listed here is told so rather than handed a guess. */
export const RELEASE_TARGETS: readonly { platform: string; arch: string }[] = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
];

export interface ReleaseDocumentInput {
  version: string;
  notes: string;
  url: string;
  bundle: Uint8Array;
  commit: string;
  builtAt: string;
  signing?: { keyId: string; privateKey: string | Uint8Array };
}

/**
 * `release.json`: a stitchkit `CliBuildManifest`, signed, which is what a current ccmux installs
 * from, and beside it the flat fields (`version`, `notes`, `sha256`, `url`, `releasedAt`) that the
 * install script and every earlier ccmux read — so a fleet still on an unsigned version updates to
 * the first signed one without knowing what a signature is. The signature covers the manifest's
 * identity and every asset's digest, never the flat fields; they name the same bundle.
 */
export function releaseDocument(input: ReleaseDocumentInput): Record<string, unknown> {
  const sha256 = new Bun.CryptoHasher('sha256').update(input.bundle).digest('hex');
  const manifest: CliBuildManifest = {
    name: 'ccmux',
    version: input.version,
    commit: input.commit,
    builtAt: input.builtAt,
    assets: RELEASE_TARGETS.map((target) => ({
      ...target,
      url: input.url,
      compression: 'none' as const,
      size: input.bundle.length,
      sha256,
    })),
  };
  return {
    ...manifest,
    ...(input.signing === undefined ? {} : { signature: signCliManifest(manifest, input.signing) }),
    notes: input.notes,
    sha256,
    url: input.url,
    releasedAt: input.builtAt,
  };
}
