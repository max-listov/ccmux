import { type FSWatcher, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { nativeCommandPath } from '../agent/codex/ownedControl.ts';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import { pendingSessionsPath, sessionsPath } from '../config/paths.ts';
import type { MachineConfig, Session } from '../types.ts';
import { managedRuntimeRoot } from './status.ts';

/** Command files wake the owner immediately; the deadline repairs missed filesystem events.
 * Status, content and locks are outputs and cannot wake their own producer. */
export class RuntimeWake {
  private watchers: FSWatcher[] = [];
  private pending = false;
  private closed = false;
  private resume: (() => void) | null = null;
  private eventTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    paths: readonly string[],
    private signal: AbortSignal,
  ) {
    const directories = new Map<string, Set<string>>();
    for (const path of paths) {
      const directory = dirname(path);
      const names = directories.get(directory) ?? new Set<string>();
      names.add(basename(path));
      directories.set(directory, names);
    }
    for (const [directory, names] of directories) {
      try {
        const watcher = watch(directory, (_event, filename) => {
          const name = String(filename);
          if (
            filename === null ||
            [...names].some((file) => name === file || name.startsWith(`${file}.tmp-`))
          ) {
            // macOS can coalesce an atomic replacement into only the temporary sibling event.
            // Give the writer its rename turn, then read the canonical command, never the temp.
            this.eventTimer ??= setTimeout(() => {
              this.eventTimer = null;
              this.notify();
            }, 10);
          }
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
