import { defineContract } from 'stitchkit/contract';
import { z } from 'zod';
import { DaemonPerformanceSchema } from '../../monitoring/performanceSchema.ts';
import { externalListContract } from './externalList.ts';
import { SERVICE_READ, SERVICE_WRITE } from './serviceEffect.ts';

export const PerformanceReadSchema = z.object({}).strict();
export const PerformanceConfigureSchema = z
  .object({ enabled: z.boolean(), reset: z.boolean().optional() })
  .strict();

export const performanceContract = defineContract(externalListContract.meta, {
  'daemon.performance': {
    method: 'POST',
    path: '/daemon/performance',
    meta: SERVICE_READ,
    desc: 'Read daemon CPU windows without changing collection',
    input: PerformanceReadSchema,
    output: DaemonPerformanceSchema,
    expose: ['HTTP', 'CLI', 'MCP'],
    tool: { name: 'performance' },
  },
  'daemon.performance.configure': {
    method: 'POST',
    path: '/daemon/performance/configure',
    meta: SERVICE_WRITE,
    desc: 'Enable or disable daemon CPU collection; reset only on transition or explicit reset',
    input: PerformanceConfigureSchema,
    output: DaemonPerformanceSchema,
    expose: ['HTTP', 'CLI', 'MCP'],
    tool: { name: 'performance_configure' },
  },
});
