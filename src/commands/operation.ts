import { runOperationProcess } from 'stitchkit/process';
import { implement } from 'stitchkit/server';
import { loadMachineConfig } from '../config/machine.ts';
import { searchFleet, searchPlan } from '../context/searchFleet.ts';
import { searchFrames } from '../context/searchFrames.ts';
import { searchContract } from '../control/schema/searchContract.ts';

/**
 * `_operation` — one control operation run in its own process: the call on stdin, its answer on
 * stdout. Started by the daemon for the operations it does not answer in its own loop
 * (`control/operations/reading.ts`); it is not a command anyone types.
 */
export async function cmdOperation(): Promise<number> {
  const m = loadMachineConfig();
  return runOperationProcess([
    implement(searchContract, {
      search: async function* ({ input }) {
        yield* searchFrames(await searchFleet(m, searchPlan(input)));
      },
    }),
  ]);
}
