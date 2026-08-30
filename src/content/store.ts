import { dirname, join } from "node:path";
import type { MachineConfig, Session } from "../types.ts";
import { atomicWrite } from "../util/atomic.ts";
import { privateRuntimeDirectory } from "../agent/codex/ownedPaths.ts";
import { managedRuntimeRoot } from "../runtime/status.ts";
import { CONTENT_FILE_MAX_BYTES, CONTENT_FLUSH_MS, ContentSnapshotSchema, type ContentSnapshot } from "./schema.ts";
import { contentNotice } from "./notice.ts";

export const contentPath = (m: Pick<MachineConfig, "stateDir">, session: Pick<Session, "name" | "uuid">) =>
  join(managedRuntimeRoot(m, session), "content.json");

/** One coalescing writer, at most one filesystem write each flush interval during token bursts. */
export class ContentWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private next: (() => ContentSnapshot) | null = null;
  private writing: Promise<void> | null = null;
  private error: unknown = null;
  private closed = false;
  readonly path: string;
  constructor(m: MachineConfig, session: Session) {
    this.path = contentPath(m, session); privateRuntimeDirectory(dirname(this.path));
    contentNotice(`${this.path}.notice`, false);
  }
  offer(snapshot: () => ContentSnapshot): void {
    if (this.closed) return;
    if (this.error !== null) throw new Error("Native content publication failed", { cause: this.error });
    this.next = snapshot;
    if (this.writing === null) this.schedule();
  }
  private schedule(): void {
    this.timer ??= setTimeout(() => { this.timer = null; void this.flush().catch(error => { this.error = error; }); }, CONTENT_FLUSH_MS);
  }
  flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.writing !== null) return this.writing;
    const next = this.next; this.next = null;
    if (next === null) return Promise.resolve();
    const bytes = JSON.stringify(ContentSnapshotSchema.parse(next()));
    if (Buffer.byteLength(bytes) > CONTENT_FILE_MAX_BYTES) throw new Error("Native content exceeds its byte budget");
    this.writing = atomicWrite(this.path, bytes, 0o600)
      .then(() => contentNotice(`${this.path}.notice`, true)).finally(() => {
      this.writing = null;
      if (this.next !== null && !this.closed) this.schedule();
    });
    return this.writing;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.flushPending();
  }
  /** A causal boundary receipt cannot become visible before its last offered snapshot is durable. */
  async flushPending(): Promise<void> {
    while (this.next !== null || this.writing !== null) await this.flush();
    if (this.error !== null) throw new Error("Native content publication failed", { cause: this.error });
  }
}
