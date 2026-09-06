import { join } from 'node:path';
import { createProcessLifecycleLedger, LifecycleStateSchema } from 'stitchkit/application';
import { createFileStateStore } from 'stitchkit/server';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';

/** The diagnostic journal owns the private parent and the daemon's lifetime lock.
 * This store records process facts, not session admission or message completion. */
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
