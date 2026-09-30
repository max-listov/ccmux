import { defineContract } from 'stitchkit/contract';
import { ExternalStatusSnapshotSchema } from '../../external/residentSchema.ts';

/** One definition serves the public control API and its small CLI relay. */
export const externalListContract = defineContract(
  { prefix: 'control', scope: 'local' },
  {
    'external.list': {
      method: 'POST',
      path: '/external',
      desc: 'Read prepared external native thread states; does not adopt or start threads',
      expose: ['HTTP', 'CLI', 'MCP'],
      output: ExternalStatusSnapshotSchema,
      tool: { name: 'external' },
    },
  },
);
