import { AppError } from 'stitchkit';
import type { z } from 'zod';
import type { ControlModelCatalog, ControlModelsReadSchema } from './schema.ts';

type ModelsReadInput = z.output<typeof ControlModelsReadSchema>;
type CatalogRead = (input: ModelsReadInput, signal: AbortSignal) => Promise<ControlModelCatalog>;

/** How long a host catalog read counts as current. Models change with releases, not by the minute. */
export const HOST_CATALOG_LIVE_MS = 10 * 60_000;
/** The budget of one background read — a cold metadata App Server was measured at 18–22 s. */
export const HOST_CATALOG_READ_MS = 60_000;
/** How long a caller with no copy waits before being told the read is still running. */
export const HOST_CATALOG_WAIT_MS = 4_000;

interface Entry {
  catalog: ControlModelCatalog;
  at: number;
}

/**
 * The host catalog, read in the background and served from the last read.
 *
 * Reading it means starting a metadata App Server, and on a loaded machine that start alone took
 * 18–22 s against a 5 s call budget: every call timed out, the process was reaped, and the next call
 * paid the same cold start again. Nothing about the catalog needs that: it changes with provider
 * releases. So a read outlives the call that asked for it, the answer is kept, and a caller gets it
 * with the instant it was observed — `live` while it is recent, `stale` after, never presented as
 * computed on the spot.
 *
 * A caller that arrives before any read has finished waits a bounded moment and is then told so by
 * name, while the read carries on. One read per input at a time; a failed read keeps the last good
 * answer and is retried by the next caller.
 */
export class HostCatalogCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly lifetime = new AbortController();

  constructor(
    private readonly read: CatalogRead,
    private readonly options = {
      liveMs: HOST_CATALOG_LIVE_MS,
      readMs: HOST_CATALOG_READ_MS,
      waitMs: HOST_CATALOG_WAIT_MS,
      now: () => Date.now(),
    },
  ) {}

  private static key(input: ModelsReadInput): string {
    return JSON.stringify([
      input.launchRecipe?.id ?? null,
      input.launchRecipe?.revision ?? null,
      input.includeHidden,
      input.limit,
      input.cursor,
    ]);
  }

  /** Start (or join) the read for this input. It is bounded by its own budget, not the caller's. */
  refresh(input: ModelsReadInput): Promise<Entry> {
    const key = HostCatalogCache.key(input);
    const running = this.inflight.get(key);
    if (running) return running;
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(this.options.readMs),
    ]);
    const pending = this.read(input, signal)
      .then((catalog) => {
        const entry = { catalog, at: this.options.now() };
        this.entries.set(key, entry);
        return entry;
      })
      .finally(() => this.inflight.delete(key));
    // A read nobody is waiting for must not surface as an unhandled rejection; the next caller
    // starts a fresh one and receives its outcome.
    pending.catch(() => {});
    this.inflight.set(key, pending);
    return pending;
  }

  async get(input: ModelsReadInput, signal?: AbortSignal): Promise<ControlModelCatalog> {
    const entry = this.entries.get(HostCatalogCache.key(input));
    if (entry) {
      if (this.options.now() - entry.at >= this.options.liveMs) void this.refresh(input);
      return this.present(entry);
    }
    const first = await Promise.race([this.refresh(input), this.waiting(signal)]);
    if (first === 'waiting')
      throw new AppError(
        'UNAVAILABLE',
        'The model catalog is still being read on this host; ask again shortly',
        503,
      );
    return this.present(first);
  }

  close(): void {
    this.lifetime.abort();
  }

  private present(entry: Entry): ControlModelCatalog {
    const live = this.options.now() - entry.at < this.options.liveMs;
    return {
      ...entry.catalog,
      source: {
        ...entry.catalog.source,
        observedAt: new Date(entry.at).toISOString(),
        freshness: live ? 'live' : 'stale',
      },
    };
  }

  private waiting(signal?: AbortSignal): Promise<'waiting'> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('waiting'), this.options.waitMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
}
