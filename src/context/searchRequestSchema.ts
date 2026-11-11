import { z } from 'zod';
import { TranscriptKindSchema, TranscriptRoleSchema } from '../agent/transcript/messageSchema.ts';

/** Matches shown when the caller does not say. The newest are kept and the count says how many more. */
export const DEFAULT_MATCHES = 50;

const PROVIDERS = ['claude', 'codex'] as const;
export const SEARCH_PROVIDERS = PROVIDERS;
/** The most matches one answer carries: `--limit 100000` is a day of everything the user wrote. */
export const SEARCH_LIMIT_MAX = 1_000_000;

/**
 * A search as a caller asks for it — the command line and the control operation hand over this one
 * shape, so the two cannot come to mean different searches.
 */
export const SearchRequestSchema = z
  .object({
    /** What to find; absent, the search is an outline and needs `project` or `since`. */
    pattern: z.string().min(1).max(4096).nullable().default(null),
    /** The pattern is a literal string, not a regular expression. */
    fixed: z.boolean().default(false),
    caseMode: z.enum(['smart', 'ignore', 'sensitive']).default('smart'),
    /** Whose messages count; absent, the user's and the agent's unless kinds are named. */
    roles: z.array(TranscriptRoleSchema).min(1).nullable().default(null),
    /** What counts as a match; absent, messages. */
    kinds: z.array(TranscriptKindSchema).min(1).nullable().default(null),
    providers: z.array(z.enum(PROVIDERS)).min(1).nullable().default(null),
    project: z.string().min(1).max(1024).nullable().default(null),
    /** today, yesterday, 7d, 12h, 2w, YYYY-MM-DD or a timestamp. */
    since: z.string().min(1).max(64).nullable().default(null),
    until: z.string().min(1).max(64).nullable().default(null),
    limit: z.int().min(1).max(SEARCH_LIMIT_MAX).default(DEFAULT_MATCHES),
    /** Each matched message's whole text instead of an excerpt. */
    full: z.boolean().default(false),
    /** Where each distinct thing the pattern matched arrived. */
    receipts: z.boolean().default(false),
    /** Machines to ask: absent, every machine of the fleet; empty, only this one. */
    machines: z.array(z.string().min(1).max(64)).max(64).nullable().default(null),
  })
  .strict();
export type SearchRequest = z.output<typeof SearchRequestSchema>;
