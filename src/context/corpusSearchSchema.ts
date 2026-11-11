import { z } from 'zod';
import { TranscriptKindSchema, TranscriptRoleSchema } from '../agent/transcript/messageSchema.ts';
import { DeclaredProjectSchema } from '../session/identitySchema.ts';
import { MessageSenderSchema } from './messageSenderSchema.ts';

/*
 * A search across every stored conversation, as one machine answers it and as a fleet of them is
 * merged. The same shape travels between machines, so it has one schema here.
 */

/** Which conversation a line is in, and whose it is. Every line, conversation and receipt of an
 *  answer carries exactly this. */
export const ConversationRefSchema = z.object({
  /** What `ccmux transcript` accepts for this conversation, from any machine of the fleet. */
  address: z.string().min(1),
  provider: z.enum(['claude', 'codex']),
  threadId: z.string().min(1),
  /** The managed session reading this conversation now, or null. */
  session: z.string().nullable(),
  /** The managed session this conversation belongs or belonged to — also for a life that session
   *  left behind at a `/clear`, a fork or a compaction. Null when no registered session lived in it. */
  ofSession: z.string().nullable(),
  dir: z.string().nullable(),
  /** `owner/name` of that directory's `origin`, where the directory is still a checkout. */
  repository: z.string().nullable(),
  project: DeclaredProjectSchema.optional(),
});
export type ConversationRef = z.infer<typeof ConversationRefSchema>;

export const CorpusMatchSchema = ConversationRefSchema.extend({
  /** Whether `seq` is a line the address opens. False for a file the transcript reader does not
   *  read by line: an earlier or compressed Codex file, a second file under an owned id. */
  lines: z.boolean(),
  seq: z.int().positive(),
  createdAt: z.string().nullable(),
  role: TranscriptRoleSchema,
  kind: TranscriptKindSchema,
  toolName: z.string().nullable(),
  field: z.enum(['text', 'input', 'output']),
  count: z.int().positive(),
  excerpt: z.object({ before: z.string(), match: z.string(), after: z.string() }),
  /** The message's whole text, when the search was asked for it (`--full`); otherwise null. */
  text: z.string().nullable(),
});
export type CorpusMatch = z.infer<typeof CorpusMatchSchema>;

/** One conversation's share of the answer: where a subject lived, before any single line of it. */
export const ConversationHitsSchema = ConversationRefSchema.extend({
  total: z.int().positive(),
  /** How many of them the user wrote, and how many the agent. */
  user: z.int().nonnegative(),
  assistant: z.int().nonnegative(),
  firstAt: z.string().nullable(),
  lastAt: z.string().nullable(),
  /** The newest match in this conversation. */
  sample: CorpusMatchSchema,
});
export type ConversationHits = z.infer<typeof ConversationHitsSchema>;

/**
 * Where a marked message arrived: one conversation that holds the mark, and the first message there
 * that carries it.
 */
export const DeliverySchema = ConversationRefSchema.extend({
  /** Whether `seq` is a line the address opens — as for a match. */
  lines: z.boolean(),
  seq: z.int().positive(),
  /** When that first message was written; null when it does not say. */
  receivedAt: z
    .string()
    .nullable()
    .describe(
      'When the first message carrying the mark in this conversation was written; null when it does not say.',
    ),
  role: TranscriptRoleSchema,
  /** The provider's id of that message within its conversation. A Claude session continued in a
   *  new file carries copies of its earlier messages under the same id; such copies are one
   *  delivery, not two. */
  messageId: z
    .string()
    .describe(
      "The provider's id of that message within its conversation. A Claude session continued in a new file carries copies of its earlier messages under the same id; such copies are one delivery.",
    ),
  /** Who sent that message, judged on the machine that holds the conversation — its ledger and its
   *  log of typed keys are the only records that can tell. Null for a message that is not the
   *  user's; absent when that machine runs a release that does not say. */
  sender: MessageSenderSchema.nullable()
    .optional()
    .describe(
      "Who sent that first message, in the words of `transcript --json`: person, session-letter, routed-input, harness, ccmux-keys or unverifiable. Null when the message is not on the user's side. Absent when the machine holding the conversation runs a release that does not say — not the same as null.",
    ),
});
export type Delivery = z.infer<typeof DeliverySchema>;

/** How many distinct marks one machine keeps receipts for. */
export const RECEIPT_MARKS_MAX = 10_000;

const receiptsOf = <D extends z.ZodType>(delivery: D) =>
  z.object({
    /** More distinct marks matched than are listed: narrow the pattern or the dates. */
    truncated: z
      .boolean()
      .describe('More distinct marks matched than are listed: narrow the pattern or the dates.'),
    /** One entry per distinct mark — the pattern's first capture group, or the whole match when it
     *  has none — oldest first by when it first arrived anywhere. */
    marks: z.array(
      z.object({
        mark: z
          .string()
          .describe(
            'What the pattern matched: its first capture group, or the whole match when it has none.',
          ),
        /** Every conversation that holds it, by when it arrived there, oldest first. */
        deliveries: z
          .array(delivery)
          .min(1)
          .describe(
            'Every conversation that holds the mark, one entry each, by when it arrived there, oldest first. `ofSession` on its machine is the session it belongs to; `limit` does not apply.',
          ),
      }),
    ),
  });
export const ReceiptsSchema = receiptsOf(DeliverySchema);
export type Receipts = z.infer<typeof ReceiptsSchema>;

/** What one machine looked through. "Nothing found" is only an answer beside these numbers. */
export const MachineCoverageSchema = z.object({
  machine: z.string().min(1),
  status: z.literal('searched'),
  elapsedMs: z.int().nonnegative(),
  /** Conversations and files that were read, and the bytes those files hold on disk. */
  conversations: z.int().nonnegative(),
  files: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  /** Files a filter ruled out without reading them. */
  skippedFiles: z.int().nonnegative(),
  /** Files that could not be read to the end; what was read of them is still counted. */
  unreadableFiles: z.int().nonnegative(),
  total: z.int().nonnegative(),
});
export type MachineCoverage = z.infer<typeof MachineCoverageSchema>;

export const MachineUnavailableSchema = z.object({
  machine: z.string().min(1),
  status: z.literal('unavailable'),
  error: z.string(),
});

/** A machine's row in the fleet's answer: the same row, with the machine that holds it. */
const onMachine = { machine: z.string().min(1) };
export const FleetConversationHitsSchema = ConversationHitsSchema.extend(onMachine);
export const FleetMatchSchema = CorpusMatchSchema.extend(onMachine);
export const FleetDeliverySchema = DeliverySchema.extend(onMachine);

export const CorpusSearchJsonSchema = z.object({
  query: z.object({
    /** Null for an outline: no pattern, every turn of the chosen conversations. */
    pattern: z.string().nullable(),
    flags: z.string(),
    roles: z.array(TranscriptRoleSchema).nullable(),
    kinds: z.array(TranscriptKindSchema),
    providers: z.array(z.enum(['claude', 'codex'])).nullable(),
    project: z.string().nullable(),
    since: z.string().nullable(),
    until: z.string().nullable(),
    limit: z.int().positive(),
    /** Each match carries the whole text of its message. */
    full: z.boolean(),
    /** The answer says where each distinct mark the pattern matched arrived. Absent in the answer
     *  of a machine that does not know the mode. */
    receipts: z.boolean().optional(),
  }),
  machines: z.array(z.union([MachineCoverageSchema, MachineUnavailableSchema])),
  total: z.int().nonnegative(),
  truncated: z.boolean(),
  /** Every conversation with a match, by its last match, oldest first. */
  conversations: z.array(FleetConversationHitsSchema),
  /** The newest `limit` matches, oldest first. */
  matches: z.array(FleetMatchSchema),
  /** Present when the search asked for receipts; `limit` does not apply to them. */
  receipts: receiptsOf(FleetDeliverySchema).optional(),
});
export type CorpusSearchJson = z.infer<typeof CorpusSearchJsonSchema>;
