import { existsSync } from 'node:fs';
import { resolveAgentSdk } from '../agent/claude/native/resolve.ts';
import type { MachineConfig, Session } from '../types.ts';
import { type RuntimeMode, runtimeModes } from './modes.ts';

/**
 * Whether this host can actually start a runtime, as opposed to merely having a mode for it.
 *
 * Kept apart from `modes.ts` because answering it needs the filesystem, and `modes.ts` is on the
 * packed client's import path where `node:` modules cannot go. The separation is the point, not a
 * tidiness: merging the two would put `node:fs` behind a schema the browser bundle imports.
 */
export interface RuntimeAvailability {
  availability: 'configured' | 'unavailable';
  reason: string | null;
}

const answer = (present: boolean, reason: string): RuntimeAvailability =>
  present ? { availability: 'configured', reason: null } : { availability: 'unavailable', reason };

export function runtimeAvailability(
  m: MachineConfig,
  agent: Session['agent'],
  mode: RuntimeMode,
): RuntimeAvailability {
  if (agent === 'claude') {
    const installed = existsSync(m.claudeBin);
    if (mode !== runtimeModes.claude.native) return answer(installed, 'runtime-not-configured');
    // Three different answers because they call for three different actions: install the CLI,
    // decide to enable the mode, or point at an SDK that is actually there. Taken from the
    // resolver that already distinguishes them rather than rebuilt from its boolean.
    if (!installed) return answer(false, 'runtime-not-configured');
    const resolved = resolveAgentSdk(m);
    if (!('unavailable' in resolved)) return answer(true, '');
    return answer(
      false,
      resolved.unavailable === 'not-enabled' ? 'runtime-not-enabled' : 'runtime-sdk-unavailable',
    );
  }
  if (agent === 'codex')
    return answer(Boolean(m.codexBin && existsSync(m.codexBin)), 'runtime-not-configured');
  if (agent === 'opencode')
    return answer(Boolean(m.opencodeBin && existsSync(m.opencodeBin)), 'runtime-not-configured');
  return answer(
    Object.values(m.launchRecipes).some((recipe) => recipe.custom !== undefined),
    'runtime-not-configured',
  );
}
