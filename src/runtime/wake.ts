import { type FSWatcher, lstatSync, type WatchListener, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { nativeCommandPath } from '../agent/codex/ownedControl.ts';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import { pendingSessionsPath, sessionsPath } from '../config/paths.ts';
import type { MachineConfig, Session } from '../types.ts';
import { managedRuntimeRoot } from './status.ts';

function fileStamp(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return null;
  }
}

/** Command files wake the owner immediately; the deadline repairs missed filesystem events.
 * Status, content and locks are outputs and cannot wake their own producer. */
export class RuntimeWake {
  private watchers: Pick<FSWatcher, 'on' | 'close'>[] = [];
  private pending = false;
  private closed = false;
  private resume: (() => void) | null = null;
  private eventTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    paths: readonly string[],
    private signal: AbortSignal,
    watchDirectory: (
      path: string,
      listener: WatchListener<string>,
    ) => Pick<FSWatcher, 'on' | 'close'> = watch,
  ) {
    const stamps = new Map(paths.map((path) => [path, fileStamp(path)]));
    const reconcile = () => {
      let changed = false;
      for (const [path, previous] of stamps) {
        const current = fileStamp(path);
        if (current !== previous) {
          stamps.set(path, current);
          changed = true;
        }
      }
      if (changed) this.notify();
    };
    for (const directory of new Set(paths.map(dirname))) {
      try {
        const watcher = watchDirectory(directory, () => {
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
    if (this.closed) return;
    this.pending = true;
    this.resume?.();
  }

  async wait(maxMs = 1_000): Promise<void> {
    if (this.closed) return;
    if (this.pending) {
      this.pending = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.resume = null;
        this.pending = false;
        resolve();
      };
      const timer = setTimeout(finish, maxMs);
      this.resume = finish;
    });
  }

  close = (): void => {
    this.closed = true;
    this.signal.removeEventListener('abort', this.close);
    if (this.eventTimer !== null) clearTimeout(this.eventTimer);
    this.eventTimer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.resume?.();
  };
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
