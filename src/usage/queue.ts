const queues = new Map<string, Set<string>>();
export function requestUsageIndex(root: string, address: string) {
  let queue = queues.get(root);
  if (!queue) {
    queue = new Set();
    queues.set(root, queue);
  }
  if (queue.size < 512) queue.add(address);
}
export function pendingUsageIndexes(root: string): string[] {
  return [...(queues.get(root) ?? [])];
}
export function finishUsageIndex(root: string, address: string) {
  queues.get(root)?.delete(address);
}
