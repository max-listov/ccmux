import { z } from 'zod';
import {
  type CorpusSearchJson,
  CorpusSearchJsonSchema,
  FleetConversationHitsSchema,
  FleetDeliverySchema,
  FleetMatchSchema,
} from './corpusSearchSchema.ts';

/**
 * A search answer as a stream of frames.
 *
 * One answer can be everything a person wrote in a day, each message whole — far past what one
 * bounded response carries. So the answer travels in parts no larger than one message: each match,
 * each conversation, each mark with where it arrived, and last the frame that says what was searched
 * and what was not. A reader that stops before `end` has not been told which machines were asked,
 * and must not read what it holds as the whole answer.
 */
export const SEARCH_FRAME_MAX_BYTES = 6 * 1024 * 1024;

const Summary = CorpusSearchJsonSchema.pick({
  query: true,
  machines: true,
  total: true,
  truncated: true,
});

export const SearchFrameSchema = z.discriminatedUnion('frame', [
  z.object({ frame: z.literal('match'), match: FleetMatchSchema }),
  z.object({ frame: z.literal('conversation'), conversation: FleetConversationHitsSchema }),
  z.object({
    frame: z.literal('mark'),
    mark: z.string(),
    deliveries: z.array(FleetDeliverySchema).min(1),
  }),
  Summary.extend({
    frame: z.literal('end'),
    /** Present when the search asked for receipts: more distinct marks matched than were sent. */
    marksTruncated: z.boolean().optional(),
  }),
]);
export type SearchFrame = z.infer<typeof SearchFrameSchema>;

/** The answer in the order a reader can use it as it arrives: what was found, then what was asked. */
export function* searchFrames(result: CorpusSearchJson): Generator<SearchFrame> {
  for (const conversation of result.conversations) yield { frame: 'conversation', conversation };
  for (const match of result.matches) yield { frame: 'match', match };
  for (const { mark, deliveries } of result.receipts?.marks ?? [])
    yield { frame: 'mark', mark, deliveries };
  yield {
    frame: 'end',
    query: result.query,
    machines: result.machines,
    total: result.total,
    truncated: result.truncated,
    ...(result.receipts === undefined ? {} : { marksTruncated: result.receipts.truncated }),
  };
}

/** A stream that ended before its last frame: the reader was not told what was searched. */
export class SearchStreamCutError extends Error {
  constructor() {
    super('the search stream ended before its last frame; what arrived is not the whole answer');
  }
}

/** The whole answer from its frames — the object `ccmux search --json` prints. */
export async function collectSearch(
  frames: AsyncIterable<SearchFrame> | Iterable<SearchFrame>,
): Promise<CorpusSearchJson> {
  const conversations: CorpusSearchJson['conversations'] = [];
  const matches: CorpusSearchJson['matches'] = [];
  const marks: NonNullable<CorpusSearchJson['receipts']>['marks'] = [];
  for await (const frame of frames) {
    if (frame.frame === 'conversation') conversations.push(frame.conversation);
    else if (frame.frame === 'match') matches.push(frame.match);
    else if (frame.frame === 'mark') marks.push({ mark: frame.mark, deliveries: frame.deliveries });
    else {
      const { frame: _end, marksTruncated, ...summary } = frame;
      return {
        ...summary,
        conversations,
        matches,
        ...(marksTruncated === undefined ? {} : { receipts: { truncated: marksTruncated, marks } }),
      };
    }
  }
  throw new SearchStreamCutError();
}
