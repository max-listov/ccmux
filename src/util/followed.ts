/**
 * A subscription as an async iterable: what it emits is yielded in order, the subscription ends
 * when the reader leaves or `signal` aborts.
 *
 * Bounded: a reader `backlog` items behind is told so (`lagged`), not handed changes out of an order
 * it can trust. A follower of the daemon is a remote reader on the other end of a socket; letting
 * its queue grow without end is the daemon's memory spent on a reader that stopped reading.
 */
export function followed<T>(
  signal: AbortSignal,
  subscribe: (emit: (item: T) => void) => () => void,
  options: { backlog: number; lagged: () => Error },
): AsyncIterable<T> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let behind = false;
  const stop = subscribe((item) => {
    if (queue.length >= options.backlog) behind = true;
    else queue.push(item);
    wake?.();
  });
  const end = () => wake?.();
  signal.addEventListener('abort', end, { once: true });
  return (async function* () {
    try {
      while (!signal.aborted) {
        if (behind) throw options.lagged();
        const next = queue.shift();
        if (next !== undefined) yield next;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        wake = null;
      }
    } finally {
      signal.removeEventListener('abort', end);
      stop();
    }
  })();
}
