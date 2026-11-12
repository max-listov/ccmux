import { z } from 'zod';
import { CorpusSearchJsonSchema } from '../context/corpusSearchSchema.ts';
import { SearchReportJsonSchema } from '../context/searchReport.ts';
import { controlContract } from '../control/schema/contract.ts';
import { controlEventsContract } from '../control/schema/eventsContract.ts';

const output = (key: keyof typeof controlContract.endpoints) =>
  z.toJSONSchema(controlContract.endpoints[key].output);

/**
 * What a command prints with `--json`, as the operation that answers the same question declares it.
 *
 * A command and its operation are built by one function of the domain (`whoisFleet`, `fleetAnswer`,
 * `chatLogAnswer`, `sendLetter`, `searchFleet`), so the answer is one object; this makes its
 * description one object too. `--schema` prints from here, and `test/command-schemas.test.ts`
 * compares what each command prints with the contract itself, so a command cannot describe an
 * answer its operation does not give.
 *
 * `search` is a stream on the wire (`search` in `controlEventsContract`): its frames are collected
 * into the answer the command prints (`collectSearch`), which is the schema here; `--report` is the
 * journal of searches, read by the command alone.
 */
export const COMMAND_SCHEMAS = {
  whois: () => ({
    answer: output('identity.whois'),
    list: output('identity.list'),
    event: z.toJSONSchema(controlEventsContract.endpoints.watchIdentities.stream.item),
  }),
  fleet: () => output('fleet.list'),
  'chat log': () => output('chat.log'),
  msg: () => ({ receipt: output('letter.send'), sent: output('letter.list') }),
  search: () => ({
    answer: z.toJSONSchema(CorpusSearchJsonSchema),
    report: z.toJSONSchema(SearchReportJsonSchema),
  }),
} as const;
