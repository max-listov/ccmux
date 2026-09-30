import { statSync } from 'node:fs';

/** Follow configured symlinks; nanosecond ctime detects rewrites with restored mtime. */
export function fileRevision(path: string): string {
  try {
    const s = statSync(path, { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid].join(':');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

/** One bounded parsed snapshot. Every read checks disk; callers own their returned objects. */
export class FileSnapshot<T> {
  private cached: { path: string; revision: string; value: T } | undefined;
  private checks = 0;
  private loads = 0;

  metrics() {
    return { checks: this.checks, loads: this.loads, retained: this.cached ? 1 : 0 };
  }

  read(path: string, load: () => T): T {
    this.checks++;
    const revision = fileRevision(path);
    if (this.cached?.path === path && this.cached.revision === revision)
      return structuredClone(this.cached.value);
    this.cached = undefined;
    this.loads++;
    const value = load();
    if (fileRevision(path) === revision)
      this.cached = { path, revision, value: structuredClone(value) };
    return value;
  }
}
