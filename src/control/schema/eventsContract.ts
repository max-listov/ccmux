import { defineContract } from 'stitchkit';
import { EXTERNAL_MAX_BYTES, ExternalStatusSnapshotSchema } from '../../external/residentSchema.ts';
import { WhoisEventSchema } from '../../session/identitySchema.ts';
import { CONTROL_MAX_BYTES, ControlSnapshotSchema } from './core.ts';
import { ControlNativeReadSchema, ControlNativeSnapshotSchema } from './native.ts';
import { IdentityListReadSchema } from './reading.ts';
import { searchContract } from './searchContract.ts';

export const controlEventsContract = defineContract(
  { prefix: 'control-events', scope: 'local' },
  {
    watch: {
      method: 'GET',
      path: '/',
      desc: 'Subscribe to bounded absolute snapshots; reconnect establishes a fresh baseline',
      stream: {
        item: ControlSnapshotSchema,
        format: 'ndjson',
        maxFrameBytes: CONTROL_MAX_BYTES + 1024,
        heartbeatMs: 2000,
      },
    },
    watchExternal: {
      method: 'GET',
      path: '/external',
      desc: 'Subscribe to prepared external native status, including unavailable and stale outcomes',
      stream: {
        item: ExternalStatusSnapshotSchema,
        format: 'ndjson',
        maxFrameBytes: EXTERNAL_MAX_BYTES + 1024,
        heartbeatMs: 2000,
      },
    },
    watchNative: {
      method: 'POST',
      path: '/native',
      desc: 'Subscribe to bounded native item frames; reset marks cursor resync',
      input: ControlNativeReadSchema,
      stream: {
        item: ControlNativeSnapshotSchema,
        format: 'ndjson',
        maxFrameBytes: CONTROL_MAX_BYTES + 1024,
        heartbeatMs: 2000,
      },
    },
    watchIdentities: {
      method: 'POST',
      path: '/identities',
      desc: 'Every session of the fleet once, then each change of its directory, project or conversation id; a machine line says a machine was read or could not be',
      input: IdentityListReadSchema,
      stream: {
        item: WhoisEventSchema,
        format: 'ndjson',
        maxFrameBytes: CONTROL_MAX_BYTES + 1024,
        heartbeatMs: 2000,
      },
    },
    ...searchContract.endpoints,
  },
);
