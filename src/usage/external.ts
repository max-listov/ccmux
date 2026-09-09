import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { StoredIndexSchema, transcriptIndexPath } from '../agent/transcriptIndex.ts';
import { CACHE_DIR } from '../config/paths.ts';
import { withExternalTranscript } from '../external/transcript.ts';
import type { MachineConfig } from '../types.ts';
import { aggregateUsage } from './aggregate.ts';
import { readUsageFile, unavailableUsage } from './file.ts';
import { partialUsage } from './quality.ts';
import type { UsageQuery } from './schema.ts';
import { UsageStore } from './store.ts';

const LocationSchema = z.object({ path: z.string() }).strict();

/** A verified location retains derived totals when native history disappears, never a writer. */
export async function readExternalUsage(
  m: MachineConfig,
  threadId: string,
  exact: string,
  query: UsageQuery,
  advance: boolean,
  signal?: AbortSignal,
) {
  const identity = createHash('sha256')
    .update(JSON.stringify([m.stateDir, m.codexSessionsDir]))
    .digest('hex');
  const locations = new UsageStore(join(CACHE_DIR, 'usage-locations', `${identity}.sqlite`));
  try {
    const prior = locations.read(threadId, LocationSchema);
    const result = await withExternalTranscript(
      m,
      threadId,
      (path) => ({
        path,
        summary: readUsageFile(exact, path, 'codex', query, advance),
      }),
      signal,
    );
    if (result.source === 'readable') {
      if (prior?.path !== result.value.path) locations.write(threadId, { path: result.value.path });
      return result.value.summary;
    }
    const unavailable = unavailableUsage(exact, 'codex', result.source, `source-${result.source}`);
    unavailable.timezone = query.timezone;
    if (!prior || !existsSync(transcriptIndexPath(prior.path))) return unavailable;
    const store = new UsageStore(transcriptIndexPath(prior.path));
    try {
      return store.transaction(() => {
        const index = store.read('index', StoredIndexSchema);
        if (index?.context.epoch !== threadId) return unavailable;
        const {
          ambiguous: _ambiguous,
          building: _building,
          ...aggregate
        } = aggregateUsage(store, query);
        for (const row of [aggregate.self, aggregate.unattributed, ...aggregate.buckets])
          partialUsage(row);
        return {
          ...unavailable,
          ...aggregate,
          observedAt: index.observedAt,
          indexedBytes: index.readOffset,
          malformedRecords: index.malformed,
        };
      });
    } finally {
      store.close();
    }
  } finally {
    locations.close();
  }
}
