import { createHash } from 'node:crypto';
import { z } from 'zod';
import { addUsage, finishUsage, usageBucket } from './accumulation.ts';
import { emptyAggregate } from './empty.ts';
import {
  UsageAggregateSchema,
  UsageBucketSchema,
  type UsageFact,
  type UsageQuery,
  UsageQuerySchema,
} from './schema.ts';
import type { UsageStore } from './store.ts';

const CacheSchema = z
  .object({
    query: UsageQuerySchema,
    self: UsageAggregateSchema,
    unattributed: UsageAggregateSchema,
    ambiguousCount: z.int().nonnegative(),
    through: z.int().nonnegative(),
    complete: z.boolean(),
  })
  .strict();
type Cache = z.infer<typeof CacheSchema>;
const BodySchema = z.object({ body: z.string() });

function apply(store: UsageStore, key: string, cache: Cache, fact: UsageFact, sign: number) {
  if (fact.counterAmbiguous) cache.ambiguousCount += sign;
  if (fact.at === null) addUsage(cache.unattributed, fact, sign);
  const q = cache.query;
  if (fact.at === null && (q.since || q.until)) return;
  if (fact.at && ((q.since && fact.at < q.since) || (q.until && fact.at >= q.until))) return;
  addUsage(cache.self, fact, sign);
  const shape = usageBucket(fact, q.timezone);
  const bucketKey = JSON.stringify(shape);
  const raw = store.db
    .query('SELECT body FROM buckets WHERE query=? AND key=?')
    .get(key, bucketKey);
  const bucket =
    raw === null
      ? { ...shape, ...emptyAggregate() }
      : UsageBucketSchema.parse(JSON.parse(BodySchema.parse(raw).body));
  addUsage(bucket, fact, sign);
  if (!bucket.observations)
    store.db.query('DELETE FROM buckets WHERE query=? AND key=?').run(key, bucketKey);
  else
    store.db
      .query(
        'INSERT INTO buckets VALUES (?,?,?) ON CONFLICT(query,key) DO UPDATE SET body=excluded.body',
      )
      .run(key, bucketKey, JSON.stringify(bucket));
}

/** Totals and only the affected buckets change atomically with each source correction. */
export function updateUsageCaches(
  store: UsageStore,
  old: UsageFact | null,
  next: UsageFact,
  sequence: number,
) {
  const rows = store.db.query("SELECT key,body FROM metadata WHERE key LIKE 'query:%'").all();
  for (const raw of rows) {
    const row = z.object({ key: z.string(), body: z.string() }).parse(raw);
    const cache = CacheSchema.parse(JSON.parse(row.body));
    if (!cache.complete && sequence > cache.through) continue;
    if (old) apply(store, row.key, cache, old, -1);
    apply(store, row.key, cache, next, 1);
    store.write(row.key, cache);
  }
}

const CursorSchema = z
  .object({ key: z.string(), revision: z.string(), offset: z.int().nonnegative() })
  .strict();
export function queryKey(query: UsageQuery, identity = '') {
  return createHash('sha256')
    .update(JSON.stringify([identity, query.since ?? null, query.until ?? null, query.timezone]))
    .digest('hex');
}
export function pageOffset(cursor: string | null, key: string, revision: string): number | null {
  if (!cursor) return 0;
  try {
    const p = CursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    return p.key === key && p.revision === revision ? p.offset : null;
  } catch {
    return null;
  }
}
export function nextPage(offset: number, key: string, revision: string) {
  return Buffer.from(JSON.stringify({ offset, key, revision })).toString('base64url');
}

/** A new time query builds at most 500 contributions; warm reads only fetch their bounded page. */
export function aggregateUsage(store: UsageStore, query: UsageQuery) {
  return store.transaction(() => {
    const revision = String(store.revision()),
      key = queryKey(query, store.identity),
      cacheKey = `query:${key}`;
    let cache = store.read(cacheKey, CacheSchema);
    if (!cache) {
      cache = {
        query,
        self: emptyAggregate(),
        unattributed: emptyAggregate(),
        ambiguousCount: 0,
        through: 0,
        complete: false,
      };
      store.db
        .query(`DELETE FROM metadata WHERE key LIKE 'query:%' AND rowid NOT IN
        (SELECT rowid FROM metadata WHERE key LIKE 'query:%' ORDER BY rowid DESC LIMIT 31)`)
        .run();
      store.db.exec('DELETE FROM buckets WHERE query NOT IN (SELECT key FROM metadata)');
    }
    if (!cache.complete) {
      const rows = store.contributionPage(cache.through, 501);
      for (const row of rows.slice(0, 500)) {
        apply(store, cacheKey, cache, row.fact, 1);
        cache.through = row.sequence;
      }
      cache.complete = rows.length <= 500;
      store.write(cacheKey, cache);
    }
    const offset = pageOffset(query.cursor, key, revision),
      start = offset ?? 0;
    const rows = store.db
      .query('SELECT body FROM buckets WHERE query=? ORDER BY key LIMIT ? OFFSET ?')
      .all(cacheKey, query.limit + 1, start);
    const buckets: z.infer<typeof UsageBucketSchema>[] = [];
    let bytes = 2;
    for (const row of rows.slice(0, query.limit)) {
      const body = BodySchema.parse(row).body;
      if (bytes + Buffer.byteLength(body) + 1 > 64 * 1024) break;
      buckets.push(UsageBucketSchema.parse(JSON.parse(body)));
      bytes += Buffer.byteLength(body) + 1;
    }
    const ambiguous = cache.ambiguousCount > 0;
    for (const value of [cache.self, cache.unattributed, ...buckets])
      finishUsage(value, ambiguous || !cache.complete);
    return {
      self: cache.self,
      sourceEventRange: store.eventRange(),
      unattributed: cache.unattributed,
      buckets,
      revision,
      ambiguous,
      building: !cache.complete,
      reset: offset === null || (!cache.complete && query.cursor !== null),
      nextCursor:
        cache.complete && buckets.length < rows.length
          ? nextPage(start + buckets.length, key, revision)
          : null,
    };
  });
}
