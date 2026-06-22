import { statSync } from "node:fs";

/** A per-path cache keyed by the file's mtime. The hot read paths (list rows, transcript pane,
 *  external discovery) re-derive the same value from an UNCHANGED jsonl every poll tick — that
 *  re-read + re-parse was the app's dominant idle cost. This returns the SAME object reference
 *  while the file hasn't changed, so (a) no re-read/re-parse happens and (b) downstream React
 *  memo (SessionCard/ChatMessage) sees a stable prop and skips re-rendering. */
export class MtimeCache<T> {
  private map = new Map<string, { mtimeMs: number; value: T }>();

  /** Return the cached value if `path`'s mtime is unchanged, else `compute()` and cache it.
   *  Returns null if the file is gone. */
  get(path: string, compute: () => T): T | null {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      this.map.delete(path);
      return null;
    }
    const hit = this.map.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    const value = compute();
    this.map.set(path, { mtimeMs, value });
    return value;
  }
}
