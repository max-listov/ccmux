import { queryKey } from './aggregate.ts';
import { type UsageQuery, UsageQuerySchema } from './schema.ts';

const queues = new Map<string, Map<string, { address: string; query: UsageQuery }>>();
export function requestUsageIndex(
  root: string,
  address: string,
  query = UsageQuerySchema.parse({}),
) {
  let queue = queues.get(root);
  if (!queue) {
    queue = new Map();
    queues.set(root, queue);
  }
  const key = queryKey(query, address);
  if (!queue.has(key) && queue.size >= 512) throw new Error('Usage query queue is full');
  queue.set(key, { address, query: { ...query, cursor: null, pipelineCursor: null } });
}
export function pendingUsageIndexes(root: string) {
  return [...(queues.get(root)?.values() ?? [])];
}
export function finishUsageIndex(root: string, address: string, query: UsageQuery) {
  queues.get(root)?.delete(queryKey(query, address));
}
