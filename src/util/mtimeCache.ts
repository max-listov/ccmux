import { statSync } from 'node:fs';

/** A per-path cache keyed by the file's mtime. The hot read paths (list rows, transcript pane,
 *  external discovery) re-derive the same value from an UNCHANGED jsonl every poll tick — that
 *  re-read + re-parse was the app's dominant idle cost. This returns the SAME object reference
 *  while the file hasn't changed, so (a) no re-read/re-parse happens and (b) downstream React
 *  memo (SessionCard/ChatMessage) sees a stable prop and skips re-rendering. */
export class MtimeCache<T> {
  private map = new Map<string, { signature: string; value: T; bytes: number }>();
  private bytes = 0;
  constructor(
    readonly maxBytes = 1024 * 1024,
    readonly maxEntries = 512,
  ) {}

  get retainedBytes(): number {
    return this.bytes;
  }

  private drop(path: string): void {
    this.bytes -= this.map.get(path)?.bytes ?? 0;
    this.map.delete(path);
  }

  /** Return the cached value if `path`'s mtime is unchanged, else `compute()` and cache it.
   *  Returns null if the file is gone. */
  get(path: string, compute: () => T): T | null {
    let signature: string;
    try {
      const stat = statSync(path);
      signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      this.drop(path);
      return null;
    }
    const hit = this.map.get(path);
    if (hit && hit.signature === signature) return hit.value;
    const value = compute();
    this.drop(path);
    // UTF-16 serialized payload + key, with fixed entry overhead; bounds retained cache payload,
    // not the JS runtime heap or the transient bounded transcript parser window.
    const bytes = 2 * ((JSON.stringify(value)?.length ?? 0) + path.length + signature.length) + 256;
    if (bytes <= this.maxBytes && this.maxEntries > 0) {
      while (this.bytes + bytes > this.maxBytes || this.map.size >= this.maxEntries) {
        const oldest = this.map.keys().next().value;
        if (oldest === undefined) break;
        this.drop(oldest);
      }
      this.map.set(path, { signature, value, bytes });
      this.bytes += bytes;
    }
    return value;
  }
}
