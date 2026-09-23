import { z } from 'zod';

/*
 * Transcript records — one message of a conversation, in the provider-neutral contract. Every
 * persisted or remote shape has one schema; its type is `z.infer` of it.
 */

export const TranscriptRoleSchema = z.enum(['user', 'assistant', 'tool', 'system', 'unknown']);
export const TranscriptKindSchema = z.enum([
  'message',
  'tool_call',
  'tool_result',
  'thinking',
  // An image the conversation carried. Its own kind rather than a message whose text says so:
  // `[image]` was a word where a picture had been, and nothing could turn that word back into one.
  'image',
  'event',
  'unknown',
]);

/**
 * An image in a transcript, addressed rather than inlined.
 *
 * The bytes stay out of the record on purpose: a message list is read constantly (it backs
 * `lastMessage` in `list --json`), and carrying pictures through it would make every listing pay
 * for content almost nobody asked to see. `address` is what a reader hands back to fetch them.
 */
export const TranscriptImageSchema = z.object({
  /** `<entry-uuid>#<block-index>` — stable for the life of the line that holds it. */
  address: z.string().min(1).max(256),
  mediaType: z.string().min(1).max(128).nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  /** Of the encoded content, so a reader can tell two pictures apart without fetching either. */
  digest: z.string().length(64).nullable(),
  /**
   * Why the image cannot be fetched, when it cannot. Null means it can. An unreadable image must
   * stay distinguishable from no image at all — that is the whole failure this replaces.
   */
  unavailable: z.enum(['unsupported-source', 'malformed', 'too-large']).nullable(),
});
export type TranscriptImage = z.infer<typeof TranscriptImageSchema>;

/** What a turn spent, exactly as the source reports it. Absent is "unknown", never zero. */
export const TranscriptUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheCreationTokens: z.number().int().nonnegative().nullable(),
});
export type TranscriptUsage = z.infer<typeof TranscriptUsageSchema>;

/**
 * The agent a Claude `Agent` call spawned, read from the agent's own transcript beside the
 * session file (`<uuid>/subagents/agent-<id>.jsonl`). The call carries this so a consumer can show
 * the agent living — with its tool calls and spend — instead of a call that "finished" the second
 * it was launched. `available` says the file was there to read; the rest is null when it was not.
 */
export const TranscriptAgentSchema = z.object({
  id: z.string(),
  /** `subagent_type` of the call: Explore, Plan, general-purpose, a custom agent's name. */
  type: z.string().nullable(),
  description: z.string().nullable(),
  model: z.string().nullable(),
  /** `finished` once the session was notified, or the agent's transcript ends on its own answer. */
  state: z.enum(['running', 'finished']),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  toolCalls: z.number().int().nonnegative().nullable(),
  /** Summed over the agent's own API messages; null when its transcript was not readable. */
  usage: TranscriptUsageSchema.nullable(),
  available: z.boolean(),
});
export type TranscriptAgent = z.infer<typeof TranscriptAgentSchema>;

export const TranscriptMessageSchema = z.object({
  id: z.string(),
  seq: z.number(),
  createdAt: z.string().nullable(),
  role: TranscriptRoleSchema,
  kind: TranscriptKindSchema,
  text: z.string().nullable(),
  title: z.string().nullable(),
  toolName: z.string().nullable(),
  toolCallId: z.string().nullable(),
  status: z.enum(['error']).nullable(),
  rawType: z.string().nullable(),
  // Tool-card fields: a tool_call's paired tool_result is FOLDED in here so the UI shows one
  // card (request on top, outcome below) instead of two stray lines. `done` = a result arrived
  // (else still running → spinner); `result` = the short outcome ("+12 −3", "248 lines").
  done: z.boolean(),
  result: z.string().nullable(),
  // Full request/response for the EXPANDED tool card: `input` = the tool_use input as pretty
  // JSON (the actual command/args), `resultText` = the paired tool_result's full output. Both
  // clipped to the display text limit; null for non-tool messages / still-running calls.
  input: z.string().nullable(),
  /** The image this message carries, addressed. Null on every other kind of message. */
  image: TranscriptImageSchema.nullable().default(null),
  /**
   * What this answer cost, when the source said. Null is "the source did not say" — a line written
   * before this existed reports unknown, and unknown is not zero tokens.
   */
  usage: TranscriptUsageSchema.nullable().default(null),
  resultText: z.string().nullable(),
  /**
   * When the folded tool_result was written — the call's end. The call's own `createdAt` is its
   * start, and without this a consumer computing durations could only guess the other edge.
   */
  doneAt: z.string().nullable().default(null),
  /** The agent this call spawned; null on every other kind of message and on every other tool. */
  agent: TranscriptAgentSchema.nullable().default(null),
});
