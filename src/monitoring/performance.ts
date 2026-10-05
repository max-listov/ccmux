import type { z } from 'zod';
import { cpuWorkScope } from '../util/cpuScope.ts';
import { producerMetrics } from '../util/producerMetrics.ts';
import type { DaemonPerformanceSchema, PerformanceScope } from './performanceSchema.ts';

/** Process CPU intervals are charged once, and only to an explicit synchronous span: the code that
 * was running is then known. CPU between spans stays unattributed even when one operation is the
 * only one open — an open operation is usually a wait (`session.wait` stays open for minutes), and
 * charging it the timers, transport and GC that ran meanwhile made a waiter look like the hottest
 * code in the daemon. These are process CPU windows, not sampled JS stacks or per-thread CPU. */
const MAX_SCOPES = 128;
const OVERFLOW_SCOPE = 'other';

export class DaemonPerformance {
  private enabled = false;
  private scopes = new Map<string, PerformanceScope>();
  private initial = process.cpuUsage();
  private previous = this.initial;
  private current: PerformanceScope | undefined;
  private started = Date.now();
  private recentSync: { name: string; endedAt: number; durationMs: number } | null = null;
  private recent: { name: string; endedAt: number; durationMs: number } | null = null;

  start(enabled = true, reset = false): void {
    if (this.enabled === enabled && !reset) return;
    this.enabled = enabled;
    this.scopes.clear();
    this.current = undefined;
    this.recent = null;
    this.recentSync = null;
    this.started = Date.now();
    this.initial = this.previous = process.cpuUsage();
  }

  private checkpoint(): void {
    if (!this.enabled) return;
    const now = process.cpuUsage();
    const scope = this.current;
    if (scope?.cpu) {
      scope.cpu.userUs += Math.max(0, now.user - this.previous.user);
      scope.cpu.systemUs += Math.max(0, now.system - this.previous.system);
    }
    this.previous = now;
  }

  private scope(name: string): PerformanceScope {
    let scope = this.scopes.get(name);
    if (!scope) {
      // Diagnostics never fail the work they observe: names past the bound share one bucket.
      if (this.scopes.size >= MAX_SCOPES && name !== OVERFLOW_SCOPE)
        return this.scope(OVERFLOW_SCOPE);
      scope = {
        name,
        runs: 0,
        failures: 0,
        active: 0,
        durationMs: 0,
        cpu: this.enabled ? { userUs: 0, systemUs: 0 } : null,
      };
      this.scopes.set(name, scope);
    }
    return scope;
  }

  /** Timer bookkeeping belongs to its schedule; it does not count as another pass. */
  callback<T>(name: string, fn: () => T): T {
    const entry = this.scope(name);
    if (!this.enabled) return this.step(entry, fn);
    return cpuWorkScope.run({ measure: (run) => this.step(entry, run) }, () =>
      this.step(entry, fn),
    );
  }

  run<T>(name: string, fn: () => T): T {
    const scope = this.scope(name);
    const entry = scope;
    this.checkpoint();
    entry.runs++;
    entry.active++;
    const start = performance.now();
    const finish = (failed: boolean) => {
      if (this.scopes.get(name) !== entry) return;
      this.checkpoint();
      entry.active--;
      if (failed) entry.failures++;
      const durationMs = performance.now() - start;
      entry.durationMs += durationMs;
      this.recent = { name, endedAt: Date.now(), durationMs };
    };
    const execute = () => {
      try {
        const result = this.step(entry, fn);
        if (result instanceof Promise)
          void result.then(
            () => finish(false),
            () => finish(true),
          );
        else finish(false);
        return result;
      } catch (error) {
        finish(true);
        throw error;
      }
    };
    return this.enabled
      ? cpuWorkScope.run({ measure: (run) => this.step(entry, run) }, execute)
      : execute();
  }

  private step<T>(entry: PerformanceScope, fn: () => T): T {
    // A synchronous span already inside this operation is covered by its enclosing window.
    // Reading process counters again for every nested metadata check only measures ourselves.
    if (this.scopes.get(entry.name) !== entry || this.current === entry) return fn();
    this.checkpoint();
    const previous = this.current;
    this.current = entry;
    const start = globalThis.performance.now();
    try {
      return fn();
    } finally {
      if (this.scopes.get(entry.name) === entry) {
        this.checkpoint();
        this.current = previous;
        const durationMs = globalThis.performance.now() - start;
        if (durationMs >= 50)
          this.recentSync = { name: entry.name, endedAt: Date.now(), durationMs };
      } else this.current = undefined;
    }
  }

  snapshot() {
    this.checkpoint();
    const now = process.cpuUsage(this.initial);
    const scopes = structuredClone([...this.scopes.values()]);
    const userUs = scopes.reduce((sum, scope) => sum + (scope.cpu?.userUs ?? 0), 0);
    const systemUs = scopes.reduce((sum, scope) => sum + (scope.cpu?.systemUs ?? 0), 0);
    const result: z.infer<typeof DaemonPerformanceSchema> = {
      basis: 'exclusive-operation-windows-and-sync-spans',
      enabled: this.enabled,
      since: new Date(this.started).toISOString(),
      elapsedMs: Date.now() - this.started,
      cpu: { userUs: now.user, systemUs: now.system },
      unattributed: {
        userUs: Math.max(0, now.user - userUs),
        systemUs: Math.max(0, now.system - systemUs),
      },
      scopes,
      producers: producerMetrics.snapshot(),
    };
    return result;
  }

  stallWork() {
    return {
      active: [...this.scopes.values()]
        .filter((scope) => scope.active > 0)
        .map((scope) => scope.name),
      recent: this.recent,
      recentSync: this.recentSync,
    };
  }

  close(): void {
    this.checkpoint();
  }
}
