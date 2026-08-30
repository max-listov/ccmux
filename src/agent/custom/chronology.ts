import { createHash } from 'node:crypto';
import type { AgentRuntimeEvent } from 'stitchkit/agent-runtime';
import type { RuntimeJournalEvent } from '../../runtime/journal.ts';
import type { OwnedRuntimeJournal } from '../../runtime/journalOwner.ts';
import type { ManagedRuntimeSnapshot } from '../../runtime/schema.ts';

/** Only metadata transitions. Current pending IDs are bounded by the native request projection. */
export class CustomChronology {
  private pending = new Set<string>();
  private gap = false;
  constructor(
    private journal: OwnedRuntimeJournal,
    private registration: string,
  ) {}
  record(kind: RuntimeJournalEvent['kind'], identity?: string): void {
    this.journal.submit({
      at: new Date().toISOString(),
      runtime: 'custom',
      registration: this.registration,
      kind,
      ...(identity
        ? { nativeIdentityHash: createHash('sha256').update(identity).digest('hex') }
        : {}),
    });
  }
  event(event: AgentRuntimeEvent): void {
    if (event.type === 'admission' || event.type === 'terminal' || event.type === 'run-state')
      this.record(
        event.type === 'admission' ? 'admitted' : event.type === 'terminal' ? 'terminal' : 'bound',
        event.runId,
      );
  }
  snapshot(value: ManagedRuntimeSnapshot): void {
    const gap = value.reason === 'native-resync-required';
    if (gap && !this.gap) this.record('observer-gap');
    this.gap = gap;
    for (const request of value.pendingRequests)
      if (!this.pending.has(request.requestId)) this.record('request-pending', request.requestId);
    this.pending = new Set(value.pendingRequests.map((request) => request.requestId));
  }
}
