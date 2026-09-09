import { existsSync, lstatSync } from 'node:fs';
import { getProvider } from '../agent/index.ts';
import {
  indexTranscript,
  StoredIndexSchema,
  transcriptIndexPath,
} from '../agent/transcriptIndex.ts';
import { countStats } from '../agent/transcriptRead.ts';
import { log } from '../util/log.ts';
import { aggregateUsage } from './aggregate.ts';
import { emptyAggregate } from './empty.ts';
import { partialUsage } from './quality.ts';
import {
  USAGE_SLICE_BYTES,
  type UsageQuery,
  type UsageSummary,
  UsageSummarySchema,
} from './schema.ts';
import { UsageStore } from './store.ts';

export function unavailableUsage(
  address: string,
  runtime: string,
  source: UsageSummary['source'],
  reason: string,
): UsageSummary {
  return {
    address,
    runtime,
    identity: { sessionId: null, nativeSessionId: null },
    source,
    reason,
    additivity: 'session-only',
    state: 'stale',
    revision: '0',
    observedAt: null,
    sourceEventRange: { first: null, last: null },
    indexedBytes: 0,
    sourceBytes: null,
    malformedRecords: 0,
    history: 'native-history',
    self: emptyAggregate(),
    unattributed: emptyAggregate(),
    delegated: { coverage: 'unknown', addresses: [] },
    reportedPipeline: null,
    buckets: [],
    timezone: 'UTC',
    nextCursor: null,
    reset: false,
  };
}

export function readUsageFile(
  address: string,
  path: string,
  runtime: string,
  query: UsageQuery,
  advance = false,
): UsageSummary {
  const result = unavailableUsage(address, runtime, 'missing', 'source-missing');
  result.timezone = query.timezone;
  if (runtime !== 'claude' && runtime !== 'codex')
    return { ...result, source: 'unsupported', reason: 'history-unsupported' };
  let sourceBytes: number | null = null;
  let sourceIdentity: string | null = null;
  let sourceMtime: number | null = null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
      throw new Error('Source ownership or type refused');
    sourceBytes = stat.size;
    sourceIdentity = `${stat.dev}:${stat.ino}`;
    sourceMtime = stat.mtimeMs;
  } catch (error) {
    result.source =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? 'missing'
        : 'unreadable';
    result.reason = `source-${result.source}`;
  }
  try {
    if (advance && sourceBytes !== null) {
      const provider = getProvider(runtime);
      const indexed = indexTranscript(
        path,
        runtime,
        (lines) => countStats(provider, lines),
        USAGE_SLICE_BYTES,
      );
      if (!indexed) return { ...result, source: 'unreadable', reason: 'source-unreadable' };
    }
    const database = transcriptIndexPath(path);
    if (!existsSync(database))
      return {
        ...result,
        source: sourceBytes === null ? result.source : 'readable',
        state: sourceBytes === null ? 'stale' : 'building',
        sourceBytes,
        reason: 'index-pending',
      };
    const store = new UsageStore(database);
    try {
      const index = store.read('index', StoredIndexSchema);
      if (!index) return { ...result, state: 'building', reason: 'index-pending' };
      const aggregate = aggregateUsage(store, query);
      const ready =
        sourceBytes !== null &&
        index.readOffset === sourceBytes &&
        index.pending === '' &&
        index.identity === sourceIdentity &&
        index.mtime === sourceMtime;
      const partial = !ready || index.malformed > 0 || aggregate.ambiguous || aggregate.building;
      if (partial)
        for (const row of [aggregate.self, aggregate.unattributed, ...aggregate.buckets])
          partialUsage(row);
      const { ambiguous: _ambiguous, building, ...page } = aggregate;
      return UsageSummarySchema.parse({
        ...result,
        ...page,
        source: sourceBytes === null ? result.source : 'readable',
        state: sourceBytes === null ? 'stale' : ready && !building ? 'ready' : 'building',
        reason:
          sourceBytes === null
            ? result.reason
            : aggregate.ambiguous
              ? 'cumulative-counter-decreased'
              : index.malformed
                ? 'malformed-records'
                : building
                  ? 'query-building'
                  : ready
                    ? null
                    : 'index-pending',
        observedAt: index.observedAt,
        indexedBytes: index.readOffset,
        sourceBytes,
        malformedRecords: index.malformed,
      });
    } finally {
      store.close();
    }
  } catch (error) {
    log.warn({ msg: 'usage accounting unavailable', err: String(error) });
    return {
      ...result,
      state: 'failed',
      source: sourceBytes === null ? result.source : 'readable',
      reason: 'accounting-unavailable',
    };
  }
}
