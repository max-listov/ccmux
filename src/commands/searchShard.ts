import { searchStored } from '../context/corpusSearch.ts';
import { corpusQuery, ShardRequestSchema } from '../context/corpusShards.ts';
import { printLine } from '../util/stdout.ts';

/** `_search-shard` — one share of a machine's search, read from stdin and answered on stdout. Run by
 *  `ccmux search` on its own machine; it is not a command anyone types. */
export async function cmdSearchShard(): Promise<number> {
  const request = ShardRequestSchema.parse(JSON.parse(await Bun.stdin.text()));
  const answer = await searchStored(
    request.machine,
    corpusQuery(request.query),
    request.conversations,
  );
  await printLine(JSON.stringify(answer));
  return 0;
}
