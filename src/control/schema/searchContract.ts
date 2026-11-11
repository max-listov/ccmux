import { defineContract } from 'stitchkit';
import { SEARCH_FRAME_MAX_BYTES, SearchFrameSchema } from '../../context/searchFrames.ts';
import { SearchRequestSchema } from '../../context/searchRequestSchema.ts';

/**
 * The search of every stored conversation, as a contract of its own.
 *
 * It is one operation of the event streams a client reads, and it is the one the daemon does not
 * answer in its own loop: a process started for the call implements exactly this contract.
 */
export const searchContract = defineContract(
  { prefix: 'control-events', scope: 'local' },
  {
    search: {
      method: 'POST',
      path: '/search',
      desc: 'Search every stored conversation of the fleet; the answer arrives in frames and ends with what was searched and what was not',
      input: SearchRequestSchema,
      stream: {
        item: SearchFrameSchema,
        format: 'ndjson',
        maxFrameBytes: SEARCH_FRAME_MAX_BYTES + 1024,
        heartbeatMs: 2000,
      },
    },
  },
);
