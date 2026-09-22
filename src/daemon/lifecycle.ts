import { join } from 'node:path';
import { createProcessLifecycleLedger, LifecycleStateSchema } from 'stitchkit/application';
import { createFileStateStore } from 'stitchkit/server';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';

/** The diagnostic journal owns the private parent and the daemon's lifetime lock.
 * This store records process facts, not session admission or message completion. */
export type DaemonLifecycle = ReturnType<typeof createDaemonLifecycle>;

export function createDaemonLifecycle(m: Pick<MachineConfig, 'stateDir'>) {
  return createProcessLifecycleLedger({
    store: createFileStateStore(join(m.stateDir, 'native-diagnostics', 'daemon-lifecycle.json'), {
      schema: LifecycleStateSchema,
      corrupt: 'throw',
    }),
    retain: 20,
    sameVersionOverlap: 'abnormal',
    onSubscriberError: (error) =>
      log.error({ msg: 'daemon lifecycle observer failed', err: error }),
  });
}

/**
 * Stamp this run's own stop when the forced drain could not.
 *
 * The force phase gets whatever is left of a seven-second budget, and under memory pressure the
 * ledger write is exactly what does not finish: the run then ends with no `stoppedAt`, and the
 * NEXT start reports an abnormal exit and an unmeasured downtime for a daemon that was asked to
 * stop. A signal handler that lies about the previous life is worse than silence — it is the one
 * line an operator reads after a rollout.
 *
 * Written here, after `shutdown()` resolved and outside every shutdown deadline. Idempotent by
 * construction: the ledger rewrites only a run still marked active, so a stop that did land is
 * left exactly as it was. Always `forced`, never `clean` — a drained shutdown is not a tidy one.
 * And a crash, an OOM kill or a power loss never reaches this line at all, so a genuinely
 * abnormal exit is still classified as one by the next start.
 */
export async function recordForcedStop(lifecycle: DaemonLifecycle): Promise<void> {
  try {
    await Promise.race([
      lifecycle.recordShutdown({ forced: true }),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  } catch (error) {
    log.warn({ msg: 'daemon could not record its own forced stop', err: String(error) });
  }
}
