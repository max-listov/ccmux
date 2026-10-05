import { type FSWatcher, type WatchListener, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createRevisionSignal } from 'stitchkit/application';
import { pendingSessionsPath, sessionsPath } from '../config/paths.ts';
import type { MachineConfig, Session } from '../types.ts';
import { fileStamp } from '../util/fileStamp.ts';
import { nativeCommandPath } from './response.ts';
import { managedRuntimeRoot } from './status.ts';
import { privateRuntimeDirectory } from './store.ts';

/** An input's stamp; an unreadable one compares as its own value until it can be read again. */
function inputStamp(path: string): string {
  try {
    return fileStamp(path, { follow: false });
  } catch {
    return 'unreadable';
  }
}

/** Command files wake the owner immediately; the deadline repairs missed filesystem events.
 * Status, content and locks are outputs and cannot wake their own producer. */
export class RuntimeWake {
  private watchers: Pick<FSWatcher, 'on' | 'close'>[] = [];
  private revisions = createRevisionSignal({ maxWaiters: 1 });
  private consumedRevision = 0;
  private closed = false;
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcile: () => void;
  private appliedRevision = -1;
  private inputRevision = 0;
  private fallback: ReturnType<typeof setInterval> | null = null;

  constructor(
    paths: readonly string[],
    private signal: AbortSignal,
    watchDirectory: (
      path: string,
      listener: WatchListener<string>,
    ) => Pick<FSWatcher, 'on' | 'close'> = watch,
    reconcileEveryMs?: number,
  ) {
    const stamps = new Map(paths.map((path) => [path, inputStamp(path)]));
    const reconcile = () => {
      let changed = false;
      for (const [path, previous] of stamps) {
        // Directory timestamps can stay unchanged when a name is created within their clock
        // resolution. Lost-event reconciliation must stat even a previously absent input.
        const current = inputStamp(path);
        if (current !== previous) {
          stamps.set(path, current);
          changed = true;
        }
      }
      if (changed) this.notify();
    };
    this.reconcile = reconcile;
    if (reconcileEveryMs !== undefined) this.fallback = setInterval(reconcile, reconcileEveryMs);
    const inputs = new Set(paths.map((path) => basename(path)));
    for (const directory of new Set(paths.map(dirname))) {
      try {
        const watcher = watchDirectory(directory, (_event, filename) => {
          if (filename !== null && !inputs.has(filename) && !/(?:^LOCK$|\.lock$)/i.test(filename))
            return;
          // A coalesced macOS event can name a LOCK rather than the changed command. Inspect
          // exact input stamps after the rename turn; output-only events never wake the owner.
          this.eventTimer ??= setTimeout(() => {
            this.eventTimer = null;
            reconcile();
          }, 10);
        });
        watcher.on('error', () => {
          watcher.close();
          this.notify();
        });
        this.watchers.push(watcher);
      } catch {
        // The bounded reconciliation remains authoritative when a watcher is unavailable.
      }
    }
    signal.addEventListener('abort', this.close, { once: true });
    if (signal.aborted) this.close();
  }

  notify(): void {
    this.inputRevision++;
    this.revisions.advance();
  }

  /** Includes commands present at startup and repairs lost watcher events at the old cadence. */
  changed(): boolean {
    if (this.fallback === null && this.inputRevision === this.appliedRevision) this.reconcile();
    const revision = this.inputRevision;
    if (revision === this.appliedRevision) return false;
    this.appliedRevision = revision;
    return true;
  }

  async wait(maxMs = 1_000): Promise<void> {
    if (this.closed) return;
    const result = await this.revisions.wait(this.consumedRevision, {
      signal: this.signal,
      timeoutMs: maxMs,
    });
    if (result.outcome === 'capacity') throw new Error('Runtime wake already has a waiting owner');
    this.consumedRevision = result.revision;
  }

  close = (): void => {
    this.closed = true;
    this.signal.removeEventListener('abort', this.close);
    if (this.eventTimer !== null) clearTimeout(this.eventTimer);
    if (this.fallback !== null) clearInterval(this.fallback);
    this.fallback = null;
    this.eventTimer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.revisions.close();
  };
}

export function nativeContextWake(m: MachineConfig, s: Session, signal: AbortSignal): RuntimeWake {
  const root = managedRuntimeRoot(m, s);
  privateRuntimeDirectory(root);
  return new RuntimeWake(
    ['context.json', 'history-read.json'].map((file) => join(root, file)),
    signal,
    watch,
    200,
  );
}

export function nativeRuntimeWake(m: MachineConfig, s: Session, signal: AbortSignal): RuntimeWake {
  const root = managedRuntimeRoot(m, s);
  const command = nativeCommandPath(m, s.name);
  privateRuntimeDirectory(root);
  privateRuntimeDirectory(dirname(command));
  return new RuntimeWake(
    [
      sessionsPath(m),
      pendingSessionsPath(m),
      command,
      ...[
        'input',
        'interrupt',
        'permission-mode',
        'rewind',
        'mcp-control',
        'context',
        'history-read',
      ].map((name) => join(root, `${name}.json`)),
    ],
    signal,
  );
}
