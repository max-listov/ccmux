import type { MachineConfig, Session } from '../types.ts';
import { runtimeAvailability } from './availability.ts';
import { RuntimeCatalogSchema, runtimeCapabilities } from './capabilities.ts';
import { runtimeModes } from './modes.ts';

/** Configuration availability is not native readiness. Version evidence arrives from the admitted driver. */
export async function readRuntimeCatalog(m: MachineConfig) {
  // One row per mode an agent actually has, walked from the table rather than written out: a
  // hand-kept list is how a mode came to be described in two places that could disagree. The
  // native mode is reported whether or not this host enabled it, with the difference stated — a
  // caller that cannot see the row cannot tell "this build has no such mode" from "this host chose
  // not to enable it", and those call for different actions.
  const entries = (Object.keys(runtimeModes) as Session['agent'][]).flatMap((runtime) =>
    runtimeModes[runtime].creatable.map((mode) => ({ runtime, mode })),
  );
  const rows = await Promise.all(
    entries.map(async ({ runtime, mode }) => ({
      runtime,
      mode,
      ...(await runtimeAvailability(m, runtime, mode)),
      capabilities: runtimeCapabilities({ agent: runtime, runtime: mode }),
    })),
  );
  return RuntimeCatalogSchema.parse({ runtimes: rows });
}
