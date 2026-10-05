import { statSync } from 'node:fs';
import { measureCpu } from './cpuScope.ts';
import { fileStamp, settled, statStamp } from './fileStamp.ts';

/** One bounded parsed snapshot. Every read checks disk; callers own their returned objects. */
export class FileSnapshot<T> {
  private cached: { path: string; revision: string; value: T } | undefined;
  private checks = 0;
  private loads = 0;

  metrics() {
    return { checks: this.checks, loads: this.loads, retained: this.cached ? 1 : 0 };
  }

  read(path: string, load: () => T): T {
    return measureCpu(() => this.readSnapshot(path, load));
  }

  private readSnapshot(path: string, load: () => T): T {
    this.checks++;
    const revision = fileStamp(path);
    if (this.cached?.path === path && this.cached.revision === revision)
      return structuredClone(this.cached.value);
    this.cached = undefined;
    this.loads++;
    const value = load();
    const after = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (after !== undefined && statStamp(after) === revision && settled(after))
      this.cached = { path, revision, value: structuredClone(value) };
    return value;
  }
}
