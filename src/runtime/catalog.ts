import { existsSync } from 'node:fs';
import { sdkAvailable } from '../agent/claude/native/resolve.ts';
import type { MachineConfig } from '../types.ts';
import { RuntimeCatalogSchema, runtimeCapabilities } from './capabilities.ts';

/** Configuration availability is not native readiness. Version evidence arrives from the admitted driver. */
export function readRuntimeCatalog(m: MachineConfig) {
  return RuntimeCatalogSchema.parse({
    runtimes: [
      {
        runtime: 'claude',
        mode: 'tui',
        availability: existsSync(m.claudeBin) ? 'configured' : 'unavailable',
        reason: existsSync(m.claudeBin) ? null : 'runtime-not-configured',
        capabilities: runtimeCapabilities({ agent: 'claude', runtime: 'tui' }),
      },
      {
        // The native mode is reported whether or not this host enabled it, with the difference
        // stated. A caller that cannot see the row at all cannot tell "this build has no such mode"
        // from "this host chose not to enable it", and those call for different actions.
        runtime: 'claude',
        mode: 'native',
        availability: sdkAvailable(m) && existsSync(m.claudeBin) ? 'configured' : 'unavailable',
        // Three different answers because they call for three different actions: install the CLI,
        // decide to enable the mode, or point at an SDK that is actually there. Collapsing them
        // would leave an operator guessing which one applies to them.
        reason: !existsSync(m.claudeBin)
          ? 'runtime-not-configured'
          : !m.claudeNativeRuntime
            ? 'runtime-not-enabled'
            : sdkAvailable(m)
              ? null
              : 'runtime-sdk-unavailable',
        capabilities: runtimeCapabilities({ agent: 'claude', runtime: 'native' }),
      },
      {
        runtime: 'codex',
        mode: 'app-server',
        availability: m.codexBin && existsSync(m.codexBin) ? 'configured' : 'unavailable',
        reason: m.codexBin && existsSync(m.codexBin) ? null : 'runtime-not-configured',
        capabilities: runtimeCapabilities({ agent: 'codex', runtime: 'app-server' }),
      },
      {
        runtime: 'opencode',
        mode: 'native',
        availability: m.opencodeBin && existsSync(m.opencodeBin) ? 'configured' : 'unavailable',
        reason: m.opencodeBin && existsSync(m.opencodeBin) ? null : 'runtime-not-configured',
        capabilities: runtimeCapabilities({ agent: 'opencode', runtime: 'native' }),
      },
      {
        runtime: 'custom',
        mode: 'native',
        availability: Object.values(m.launchRecipes).some((recipe) => recipe.custom !== undefined)
          ? 'configured'
          : 'unavailable',
        reason: Object.values(m.launchRecipes).some((recipe) => recipe.custom !== undefined)
          ? null
          : 'runtime-not-configured',
        capabilities: runtimeCapabilities({ agent: 'custom', runtime: 'native' }),
      },
    ],
  });
}
