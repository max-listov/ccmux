import { AppError } from 'stitchkit';
import { type BoundedChannel, createBoundedChannel } from 'stitchkit/application';

/**
 * The readers of one resident snapshot.
 *
 * A reader holds a revision NOTICE, never a queue of snapshots: its channel keeps the latest number
 * only, and each wake reads the snapshot as it is now. So a slow reader costs eight bytes however far
 * behind it falls, and the number of readers never causes the producer to do any work.
 */
class SnapshotReaders<T> {
  private readers = new Set<BoundedChannel<number>>();
  private stopped = false;

  constructor(
    private readonly options: {
      /** Named in the refusals. */
      label: string;
      limit: number;
      read: () => T;
    },
  ) {}

  get closed(): boolean {
    return this.stopped;
  }

  get count(): number {
    return this.readers.size;
  }

  /** Wake every reader: revision `sequence` is the one to read. */
  notify(sequence: number): void {
    for (const reader of this.readers) reader.offer(sequence);
  }

  /** The snapshot now, and again after every notice, until `signal` aborts or the readers close. */
  subscribe(signal: AbortSignal, sequence: number): AsyncIterable<T> {
    signal.throwIfAborted();
    if (this.stopped)
      throw new AppError('UNAVAILABLE', `${this.options.label} publisher is stopped`, 503);
    if (this.readers.size >= this.options.limit)
      throw new AppError('BUSY', `${this.options.label} subscriber limit reached`, 429);
    const channel = createBoundedChannel<number>({
      policy: 'latest',
      maxItems: 1,
      maxBytes: 8,
      sizeOf: () => 8,
      signal,
    });
    this.readers.add(channel);
    channel.offer(sequence);
    const remove = () => {
      this.readers.delete(channel);
      channel.close({ mode: 'discard' });
    };
    signal.addEventListener('abort', remove, { once: true });
    const read = this.options.read;
    return (async function* () {
      try {
        for await (const _revision of channel) yield read();
      } finally {
        signal.removeEventListener('abort', remove);
        remove();
      }
    })();
  }

  /** End every stream after what it was last told. */
  close(): void {
    this.stopped = true;
    for (const reader of this.readers) reader.close();
  }
}

/**
 * One producer of a resident snapshot and its readers.
 *
 * A subclass owns what the snapshot says and how it changes; this owns who is told, and how a
 * stop reaches them. `close` publishes the reason first and ends the streams after, so the last
 * thing every reader sees is why it stopped — not the last observation before it did.
 */
export abstract class SnapshotPublisher<T extends { sequence: number }> {
  protected readonly readers: SnapshotReaders<T>;

  constructor(
    protected snapshot: T,
    readers: { label: string; limit: number },
  ) {
    this.readers = new SnapshotReaders<T>({ ...readers, read: () => this.read() });
  }

  /** The snapshot as it stands now, with its freshness judged against `now`. */
  abstract read(now?: number): T;

  /** Publish that there is nothing to observe, and why. */
  abstract unavailable(reason: 'daemon-stopped'): void;

  subscribe(signal: AbortSignal): AsyncIterable<T> {
    return this.readers.subscribe(signal, this.snapshot.sequence);
  }

  get subscribers(): number {
    return this.readers.count;
  }

  close(): void {
    if (this.readers.closed) return;
    this.unavailable('daemon-stopped');
    this.readers.close();
  }

  protected notify(): void {
    this.readers.notify(this.snapshot.sequence);
  }
}
