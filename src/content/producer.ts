import type { MachineConfig, Session } from "../types.ts";
import { ContentBuffer } from "./buffer.ts";
import { ContentWriter } from "./store.ts";

export class ContentProducer {
  readonly buffer: ContentBuffer;
  readonly writer: ContentWriter;
  constructor(m: MachineConfig, session: Session, generation: string) {
    this.buffer = new ContentBuffer(m, session, generation); this.writer = new ContentWriter(m, session);
    this.publish();
  }
  publish(): void { this.writer.offer(() => this.buffer.snapshot()); }
  async close(): Promise<void> { this.buffer.unavailable(); this.publish(); await this.writer.close(); }
}
