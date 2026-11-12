import type { z } from 'zod';
import { peersOf, runPeer } from '../fleet/transport.ts';
import type { MachineConfig } from '../types.ts';
import { UsageListResultSchema } from './schema.ts';

type UsageListResult = z.output<typeof UsageListResultSchema>;

/**
 * `ccmux usage --fleet`: this machine's sessions beside every other machine's, each asked with the
 * same command line. A machine that does not answer, or answers for a machine it is not, is a row
 * that says so; the whole answer is `partial` when any row is short of complete.
 */
export async function fleetUsage(
  m: MachineConfig,
  local: UsageListResult,
  remoteArgs: readonly string[],
  run: typeof runPeer = runPeer,
) {
  const machines = await Promise.all(
    peersOf(m).map(async (peer) => {
      const result = await run(m, peer.machine, peer.alias, ['ccmux', 'usage', ...remoteArgs], {
        timeoutMs: 10_000,
        connectTimeoutSeconds: 3,
      });
      if (result.transportFailed || (result.code !== 0 && result.code !== 2))
        return { machine: peer.machine, status: 'unavailable', data: null };
      try {
        const data = UsageListResultSchema.parse(JSON.parse(result.stdout));
        if (data.machine !== peer.machine) throw new Error('Machine identity mismatch');
        return { machine: peer.machine, status: 'available', data };
      } catch {
        return { machine: peer.machine, status: 'unavailable', data: null };
      }
    }),
  );
  const all = [{ machine: m.rcPrefix, status: 'available', data: local }, ...machines];
  const partial = all.some(
    (row) =>
      row.status !== 'available' ||
      row.data?.nextCursor ||
      row.data?.data.some((s) => s.self.coverage !== 'full' || s.state !== 'ready'),
  );
  return {
    coverage: partial ? ('partial' as const) : ('full' as const),
    machines: all,
    total: null,
    totalReason: 'cross-session-lineage-unproven' as const,
  };
}
