import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MachineConfig } from '../../../types.ts';

/**
 * Where the running copy of the agent SDK comes from.
 *
 * From the host, not from this bundle — the same footing every other vendor runtime here stands on.
 * `codexBin` and `opencodeBin` are paths an operator provides; only the Custom harness is embedded,
 * because that one is ours. Bundling a vendor SDK would put roughly 1.4 MB into every fleet host for
 * a mode almost none of them enable, and would tie the version every host runs to whenever this
 * project last cut a release.
 *
 * The consequence to keep in view: the SDK and the CLI it drives are released in lockstep, so the
 * pairing an operator installs is the pairing that runs. That is the operator's to manage, and this
 * resolution is the one place it is decided.
 */

export type SdkResolution =
  | { path: string }
  | { unavailable: 'not-enabled' | 'not-configured' | 'not-found'; detail: string };

export function resolveAgentSdk(m: MachineConfig): SdkResolution {
  if (!m.claudeNativeRuntime)
    return {
      unavailable: 'not-enabled',
      detail: 'the native Claude runtime is not enabled on this host',
    };
  const root = m.claudeNativeSdk;
  if (root === undefined)
    return {
      unavailable: 'not-configured',
      // Named separately from "not enabled" because the actions differ: one is a decision to make,
      // the other is an install to point at.
      detail: 'claudeNativeSdk is not set; install the agent SDK and give its package root',
    };
  const entry = join(root, 'sdk.mjs');
  if (!existsSync(entry))
    return {
      unavailable: 'not-found',
      detail: `no agent SDK at ${root}`,
    };
  return { path: entry };
}
