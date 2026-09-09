import { createManagedSchedule, type ManagedScheduleClock } from 'stitchkit/application';
import { loadSessions } from '../config/sessions.ts';
import type { ExternalStatusPublisher } from '../external/resident-publisher.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import { pendingUsageIndexes } from './queue.ts';
import { UsageQuerySchema } from './schema.ts';
import { readSessionUsage } from './service.ts';

/** One bounded source slice per tick; busy histories cannot starve another session. */
export function createUsageObservation(
  machine: () => MachineConfig,
  external: ExternalStatusPublisher,
  clock?: ManagedScheduleClock,
) {
  let cursor = 0;
  return createManagedSchedule({
    id: 'usage-observation',
    everyMs: 100,
    ...(clock ? { clock } : {}),
    overlap: { mode: 'skip' },
    run: async ({ signal }) => {
      signal.throwIfAborted();
      const m = machine();
      const managed = loadSessions(m);
      const ids = new Set(managed.filter((s) => s.agent === 'codex').map((s) => s.uuid));
      const addresses = [
        ...new Set([
          ...managed.map((s) => `${m.rcPrefix}:${s.name}`),
          ...external
            .read()
            .sessions.filter((s) => !ids.has(s.identity.threadId))
            .map((s) => `${m.rcPrefix}:app/${s.identity.threadId}`),
          ...pendingUsageIndexes(m.stateDir),
        ]),
      ];
      if (!addresses.length) return;
      const address = addresses[cursor++ % addresses.length];
      if (!address) return;
      const result = await readSessionUsage(m, address, UsageQuerySchema.parse({}), true, signal);
      if (result.state === 'failed') throw new Error(result.reason ?? 'Usage observation failed');
    },
    onError: (error) => log.warn({ msg: 'usage observation failed', err: String(error) }),
  });
}
