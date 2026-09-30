import { AsyncLocalStorage } from 'node:async_hooks';

export const cpuWorkScope = new AsyncLocalStorage<{ measure: <T>(run: () => T) => T }>();

/** Explicit synchronous spans work after await in Bun, whose async_hooks are stubs. */
export function measureCpu<T>(run: () => T): T {
  const scope = cpuWorkScope.getStore();
  return scope ? scope.measure(run) : run();
}
