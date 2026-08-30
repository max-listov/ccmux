import { AppError } from 'stitchkit';
import { type BoundedChannel, createBoundedChannel } from 'stitchkit/application';
import { VERSION } from '../util/version.ts';
import {
  currentExternalStatus,
  EXTERNAL_MAX_BYTES,
  EXTERNAL_MAX_READERS,
  EXTERNAL_MAX_ROWS,
  EXTERNAL_TTL_MS,
  type ExternalStatusRow,
  type ExternalStatusSnapshot,
} from './resident-schema.ts';

/** Prepared facts only; subscriber count never causes provider work. */
export class ExternalStatusPublisher {
  private snapshot: ExternalStatusSnapshot;
  private readers = new Set<BoundedChannel<number>>();
  private closed = false;
  private freshness = '';

  constructor(machine: string) {
    this.snapshot = {
      protocol: 1,
      version: VERSION,
      machine,
      generation: crypto.randomUUID(),
      sequence: 0,
      source: 'codex-app-server',
      status: 'unavailable',
      reason: 'observation-pending',
      observedAt: null,
      expiresAt: null,
      truncated: false,
      omitted: 0,
      sessions: [],
    };
  }

  reconnect(): void {
    this.snapshot.generation = crypto.randomUUID();
    this.unavailable('observation-pending');
  }

  publish(rows: ExternalStatusRow[], truncated: boolean, observedAt: number): void {
    if (this.closed) return;
    const sessions: ExternalStatusRow[] = [];
    let bytes = 4096,
      omitted = 0;
    // Preserve observed active/idle threads before unknown history when the byte bound is reached.
    const ordered = [...rows].sort(
      (a, b) =>
        Number(b.turnState.evidence === 'observed') - Number(a.turnState.evidence === 'observed'),
    );
    for (const row of ordered) {
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (sessions.length >= EXTERNAL_MAX_ROWS || bytes + size > EXTERNAL_MAX_BYTES) {
        omitted++;
        continue;
      }
      bytes += size;
      sessions.push(row);
    }
    this.snapshot = {
      ...this.snapshot,
      sequence: this.snapshot.sequence + 1,
      status: 'live',
      reason: null,
      observedAt: new Date(observedAt).toISOString(),
      expiresAt: new Date(observedAt + EXTERNAL_TTL_MS).toISOString(),
      sessions,
      omitted,
      truncated: truncated || omitted > 0,
    };
    this.notify();
  }

  unavailable(reason: NonNullable<ExternalStatusSnapshot['reason']>): void {
    this.snapshot = currentExternalStatus({ ...this.snapshot, status: 'unavailable', reason });
    this.snapshot.sequence++;
    this.notify();
  }

  read(now = Date.now()): ExternalStatusSnapshot {
    return currentExternalStatus(this.snapshot, now);
  }

  expire(): void {
    const state = this.read();
    const key = JSON.stringify([state.status, state.sessions.map((row) => row.turnState.evidence)]);
    if (key === this.freshness || this.closed) return;
    this.freshness = key;
    this.snapshot.sequence++;
    this.notify();
  }

  subscribe(signal: AbortSignal): AsyncIterable<ExternalStatusSnapshot> {
    signal.throwIfAborted();
    if (this.closed) throw new AppError('UNAVAILABLE', 'External status publisher is stopped', 503);
    if (this.readers.size >= EXTERNAL_MAX_READERS)
      throw new AppError('BUSY', 'External subscriber limit reached', 429);
    const channel = createBoundedChannel<number>({
      policy: 'latest',
      maxItems: 1,
      maxBytes: 8,
      sizeOf: () => 8,
      signal,
    });
    this.readers.add(channel);
    channel.offer(this.snapshot.sequence);
    const remove = () => {
      this.readers.delete(channel);
      channel.close({ mode: 'discard' });
    };
    signal.addEventListener('abort', remove, { once: true });
    const publisher = this;
    return (async function* () {
      try {
        for await (const _ of channel) yield publisher.read();
      } finally {
        signal.removeEventListener('abort', remove);
        remove();
      }
    })();
  }

  get subscribers(): number {
    return this.readers.size;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unavailable('daemon-stopped');
    for (const reader of this.readers) reader.close();
  }
  private notify(): void {
    for (const reader of this.readers) reader.offer(this.snapshot.sequence);
  }
}
