import { existsSync } from 'node:fs';
import { StoredIndexSchema, transcriptIndexPath } from '../agent/transcriptIndex.ts';
import { aggregateUsage } from './aggregate.ts';
import { partialUsage } from './quality.ts';
import { UsageQuerySchema } from './schema.ts';
import { UsageStore } from './store.ts';

export function indexedUsage(path: string) {
  const database = transcriptIndexPath(path);
  if (!existsSync(database)) return null;
  const store = new UsageStore(database);
  try {
    const result = aggregateUsage(store, UsageQuerySchema.parse({}));
    const index = store.read('index', StoredIndexSchema);
    if (
      result.building ||
      !index ||
      index.malformed ||
      index.pending ||
      index.readOffset !== index.observedSize
    )
      partialUsage(result.self);
    return result.self;
  } finally {
    store.close();
  }
}
