import { loadMachineConfig } from '../config/machine.ts';
import { SEARCH_TEXT_LIMIT, searchStored } from '../context/corpusSearch.ts';
import { corpusQuery, ShardRequestSchema } from '../context/corpusShards.ts';
import { conversationSenders } from '../context/messageSender.ts';
import { printLine } from '../util/stdout.ts';

/** `_search-shard` — one share of a machine's search, read from stdin and answered on stdout. Run by
 *  `ccmux search` on its own machine; it is not a command anyone types. */
export async function cmdSearchShard(): Promise<number> {
  const request = ShardRequestSchema.parse(JSON.parse(await Bun.stdin.text()));
  const m = loadMachineConfig();
  const answer = await searchStored(
    request.machine,
    corpusQuery(request.query),
    request.conversations,
    // A share is this machine's own: its judge reads the same ledger and log as an unshared read.
    request.senders && m.rcPrefix === request.machine
      ? conversationSenders(m, SEARCH_TEXT_LIMIT)
      : undefined,
  );
  await printLine(JSON.stringify(answer));
  return 0;
}
