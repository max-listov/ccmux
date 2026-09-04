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

  /**
   * A connection is being attempted: the state is pending, and the numbering is untouched.
   *
   * An ATTEMPT invalidates nothing — no new observation exists to separate from the old ones — so
   * minting a generation here spent the consumer's one irreversible resource on an event that had
   * not happened. On a machine whose provider is absent every refresh tick attempted, failed, and
   * burned a generation: measured at seven in twelve seconds with zero external sessions and a
   * sequence that never broke, which is the contradiction a reader saw. A consumer must retire
   * every generation it is shown, so at that rate it reached its bound in four minutes and dropped
   * the stream.
   */
  connecting(): void {
    // Pending is news only when something was being observed a moment ago. A retry against a
    // provider that is already known to be absent tells a consumer nothing it does not have — and
    // announcing it overwrites the reason that DOES carry information (the failure) with the one
    // that carries none, once per tick, forever. So the last failure stands until it changes.
    if (this.snapshot.status !== 'live') return;
    this.unavailable('observation-pending');
  }

  /**
   * A connection was established: this is a new producer of observations, and the boundary is real.
   *
   * Called after the connect succeeds, which is what makes the generation mean what the contract
   * says — everything numbered before it came from a source that is gone.
   */
  producerChanged(): void {
    this.snapshot.generation = crypto.randomUUID();
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
    // Saying the same thing again is not news. A provider that is absent produces this call on
    // every reconciliation tick, and each one used to advance the sequence and wake every reader
    // with a snapshot identical to the last — a stream that is busiest exactly when there is
    // nothing to report. A CHANGE of status or reason still goes out immediately.
    if (this.closed) return;
    if (this.snapshot.status === 'unavailable' && this.snapshot.reason === reason) return;
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
