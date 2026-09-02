import { z } from 'zod';

/**
 * Why delivery is held, as a value a consumer can branch on.
 *
 * The vocabulary already existed — `ChatPaneState` — and was thrown away at exactly this point:
 * only the prose was persisted, so everything downstream had a sentence where it needed a kind. A
 * consumer reading "queued" could not tell a recipient sitting in a selection menu, which needs a
 * person, from one mid-turn, which needs nothing but time; it showed "queued" for both, and a
 * conversation sat that way for twenty-two hours.
 *
 * `other` is for a hold recorded before this field existed, or by a future site that has not been
 * given a kind. It means "the text is all there is", never "nothing is wrong".
 */
export const ChatHoldKindSchema = z.enum([
  'working',
  'queued-input',
  'menu',
  'input-busy',
  'not-drawn',
  'rate-limited',
  'human-typing',
  'not-settled',
  'other',
]);
export type ChatHoldKind = z.infer<typeof ChatHoldKindSchema>;
