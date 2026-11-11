import { statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { z } from 'zod';
import { TranscriptKindSchema, TranscriptRoleSchema } from '../agent/transcript/messageSchema.ts';
import { SELF_ARGV } from '../util/env.ts';
import { run } from '../util/spawn.ts';
import {
  type CorpusQuery,
  type MachineSearch,
  mergeReceipts,
  olderConversation,
  olderMatch,
  searchStored,
} from './corpusSearch.ts';
import {
  ConversationHitsSchema,
  CorpusMatchSchema,
  type MachineCoverage,
  MachineCoverageSchema,
  ReceiptsSchema,
} from './corpusSearchSchema.ts';
import type { StoredConversation } from './storedConversations.ts';

/**
 * A machine's search spread over its cores.
 *
 * Reading a conversation is decoding and parsing, which one process does on one core: measured on
 * 14.7 GB (269 conversations), one process took 41–74 s depending on what else the machine was
 * doing. The conversations are independent, so they are dealt out by size to several copies of this
 * program, each of which reads its share and answers with its newest matches; nothing is shared
 * between them and nothing outlives the search.
 */

const ProviderSchema = z.enum(['claude', 'codex']);

export const ShardRequestSchema = z.object({
  machine: z.string().min(1),
  query: z.object({
    source: z.string().min(1).nullable(),
    flags: z.string(),
    roles: z.array(TranscriptRoleSchema).nullable(),
    kinds: z.array(TranscriptKindSchema),
    providers: z.array(ProviderSchema).nullable(),
    project: z.string().nullable(),
    since: z.number().nullable(),
    until: z.number().nullable(),
    limit: z.int().positive(),
    full: z.boolean(),
    receipts: z.boolean(),
  }),
  conversations: z.array(
    z.object({
      provider: ProviderSchema,
      threadId: z.string(),
      address: z.string(),
      session: z.string().nullable(),
      ofSession: z.string().nullable(),
      dir: z.string().nullable(),
      files: z.array(
        z.object({
          path: z.string(),
          compressed: z.boolean(),
          lines: z.boolean(),
          startMs: z.number().nullable(),
        }),
      ),
    }),
  ),
});
export type ShardRequest = z.infer<typeof ShardRequestSchema>;

export const ShardAnswerSchema = z.object({
  coverage: MachineCoverageSchema,
  conversations: z.array(ConversationHitsSchema),
  matches: z.array(CorpusMatchSchema),
  receipts: ReceiptsSchema.optional(),
});

/** Below this a second process costs more to start than it saves. */
const SHARD_MIN_BYTES = 512 * 1024 * 1024;
/** Each process holds a few hundred megabytes while it reads; more of them than this buys little. */
const MAX_SHARDS = 6;
/** A process that has not answered in this long is not going to. Its share is then read here. */
const SHARD_TIMEOUT_MS = 170_000;

export function shardCount(bytes: number, cores = availableParallelism()): number {
  // One core is left for whatever the machine was already doing.
  return Math.max(1, Math.min(MAX_SHARDS, cores - 1, Math.ceil(bytes / SHARD_MIN_BYTES)));
}

function bytesOf(conversation: StoredConversation): number {
  let bytes = 0;
  for (const file of conversation.files) {
    try {
      bytes += statSync(file.path).size;
    } catch {
      // Gone since it was listed; the search counts it as skipped.
    }
  }
  return bytes;
}

/** Largest first, each to whichever share is lightest so far: the shares finish close together. */
export function dealOut<T>(items: readonly { item: T; bytes: number }[], shares: number): T[][] {
  const out = Array.from({ length: shares }, () => ({ bytes: 0, items: [] as T[] }));
  for (const { item, bytes } of [...items].sort((a, b) => b.bytes - a.bytes)) {
    const lightest = out.reduce((best, share) => (share.bytes < best.bytes ? share : best));
    lightest.items.push(item);
    lightest.bytes += bytes;
  }
  return out.map((share) => share.items).filter((share) => share.length > 0);
}

export function shardQuery(query: CorpusQuery): ShardRequest['query'] {
  return {
    source: query.pattern?.source ?? null,
    flags: query.pattern?.flags ?? '',
    roles: query.roles === undefined ? null : [...query.roles],
    kinds: [...query.kinds],
    providers: query.providers === undefined ? null : [...query.providers],
    project: query.project ?? null,
    since: query.since ?? null,
    until: query.until ?? null,
    limit: query.limit,
    full: query.full === true,
    receipts: query.receipts === true,
  };
}

export function corpusQuery(wire: ShardRequest['query']): CorpusQuery {
  const query: CorpusQuery = {
    kinds: new Set(wire.kinds),
    limit: wire.limit,
  };
  if (wire.source !== null) query.pattern = new RegExp(wire.source, wire.flags);
  if (wire.roles !== null) query.roles = new Set(wire.roles);
  if (wire.providers !== null) query.providers = new Set(wire.providers);
  if (wire.project !== null) query.project = wire.project;
  if (wire.since !== null) query.since = wire.since;
  if (wire.until !== null) query.until = wire.until;
  if (wire.full) query.full = true;
  if (wire.receipts) query.receipts = true;
  return query;
}

async function shard(
  machine: string,
  query: CorpusQuery,
  conversations: StoredConversation[],
): Promise<MachineSearch> {
  const request: ShardRequest = { machine, query: shardQuery(query), conversations };
  try {
    const child = await run([...SELF_ARGV, '_search-shard'], {
      input: JSON.stringify(request),
      timeoutMs: SHARD_TIMEOUT_MS,
    });
    if (child.code === 0) return ShardAnswerSchema.parse(JSON.parse(child.stdout));
  } catch {
    // Answered below, by reading the same share in this process.
  }
  // A share nobody read would be a silent hole in "everything was searched".
  return searchStored(machine, query, conversations);
}

export async function searchMachine(
  machine: string,
  query: CorpusQuery,
  conversations: readonly StoredConversation[],
  shares?: number,
): Promise<MachineSearch> {
  const started = performance.now();
  const wanted =
    query.providers === undefined
      ? conversations
      : conversations.filter((conversation) => query.providers?.has(conversation.provider));
  const sized = wanted.map((item) => ({ item, bytes: bytesOf(item) }));
  const count = shares ?? shardCount(sized.reduce((sum, entry) => sum + entry.bytes, 0));
  if (count <= 1) return searchStored(machine, query, conversations);
  const parts = await Promise.all(
    dealOut(sized, count).map((share) => shard(machine, query, share)),
  );
  const [first, ...rest] = parts.map((part) => part.coverage);
  const coverage = { ...(first as MachineCoverage) };
  for (const part of rest) {
    coverage.conversations += part.conversations;
    coverage.files += part.files;
    coverage.bytes += part.bytes;
    coverage.skippedFiles += part.skippedFiles;
    coverage.unreadableFiles += part.unreadableFiles;
    coverage.total += part.total;
  }
  // Conversations of a provider nobody asked for were never dealt out, and are still not searched.
  coverage.skippedFiles += conversations
    .filter((conversation) => !wanted.includes(conversation))
    .reduce((sum, conversation) => sum + conversation.files.length, 0);
  coverage.elapsedMs = Math.round(performance.now() - started);
  const matches = parts
    .flatMap((part) => part.matches)
    .sort(olderMatch)
    .slice(-query.limit);
  const found = parts.flatMap((part) => part.conversations).sort(olderConversation);
  return {
    coverage,
    conversations: found,
    matches,
    ...(query.receipts === true
      ? { receipts: mergeReceipts(parts.map((part) => part.receipts)) }
      : {}),
  };
}
