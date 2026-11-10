import { z } from 'zod';
import { TranscriptKindSchema, TranscriptRoleSchema } from '../agent/transcript/messageSchema.ts';

/*
 * A search across every stored conversation, as one machine answers it and as a fleet of them is
 * merged. The same shape travels between machines, so it has one schema here.
 */

export const CorpusMatchSchema = z.object({
  /** What `ccmux transcript` accepts for this conversation, from any machine of the fleet. */
  address: z.string().min(1),
  provider: z.enum(['claude', 'codex']),
  threadId: z.string().min(1),
  /** The managed session reading this conversation now, or null. */
  session: z.string().nullable(),
  dir: z.string().nullable(),
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
});
export type CorpusMatch = z.infer<typeof CorpusMatchSchema>;

/** One conversation's share of the answer: where a subject lived, before any single line of it. */
export const ConversationHitsSchema = z.object({
  address: z.string().min(1),
  provider: z.enum(['claude', 'codex']),
  threadId: z.string().min(1),
  session: z.string().nullable(),
  dir: z.string().nullable(),
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
  }),
  machines: z.array(z.union([MachineCoverageSchema, MachineUnavailableSchema])),
  total: z.int().nonnegative(),
  truncated: z.boolean(),
  /** Every conversation with a match, by its last match, oldest first. */
  conversations: z.array(ConversationHitsSchema.extend({ machine: z.string().min(1) })),
  /** The newest `limit` matches, oldest first. */
  matches: z.array(CorpusMatchSchema.extend({ machine: z.string().min(1) })),
});
export type CorpusSearchJson = z.infer<typeof CorpusSearchJsonSchema>;
