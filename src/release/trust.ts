import type { CliTrustRoot } from 'stitchkit/cli';
import type { MachineConfig } from '../types.ts';

/**
 * The key ccmux releases are signed with, compiled into the bundle.
 *
 * A trust root fetched at runtime from the same place as the release would prove nothing: whoever
 * can replace `release.json` could replace it too. The private half lives only in the CI secret
 * `CCMUX_RELEASE_SIGNING_KEY`; rotating it means publishing a release, signed with the old key,
 * whose bundle names the new one.
 */
export const RELEASE_KEYS: Readonly<Record<string, string>> = {
  'ccmux-2026-09': 'vZlOErFFvHVcdGlWU7TiCKsmJCL/c+2AcJcwQYqTwFg=',
};

/** The keys this machine accepts: the compiled ones, plus any its own `machine.json` adds for a
 *  release feed it signs itself (a self-hosted mirror, a test). Editing that file already takes the
 *  access that replacing the bundle does, so it grants nothing new. */
export function releaseTrust(m: Pick<MachineConfig, 'releaseTrustKeys'>): CliTrustRoot {
  return { keys: { ...RELEASE_KEYS, ...(m.releaseTrustKeys ?? {}) } };
}
