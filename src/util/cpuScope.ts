import { AsyncLocalStorage } from 'node:async_hooks';

export const cpuWorkScope = new AsyncLocalStorage<{ measure: <T>(run: () => T) => T }>();

/**
 * Charge one synchronous span to the operation whose scope is current. The scope reaches code that
 * runs after an `await` because AsyncLocalStorage propagates through Bun's promises and timers; what
 * Bun lacks is `async_hooks.createHook`, so CPU is measured only inside explicit spans like this one.
 */
export function measureCpu<T>(run: () => T): T {
  const scope = cpuWorkScope.getStore();
  return scope ? scope.measure(run) : run();
}

/** `fn`, measured as a synchronous span of whichever operation calls it. */
export function measured<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => measureCpu(() => fn(...args));
}
