import type { MachineConfig, Session } from '../types.ts';
import { ContentBuffer } from './buffer.ts';
import { ContentWriter } from './store.ts';

export class ContentProducer {
  private offeredRevision = -1;
  readonly buffer: ContentBuffer;
  readonly writer: ContentWriter;
  constructor(m: MachineConfig, session: Session, generation: string) {
    this.buffer = new ContentBuffer(m, session, generation);
    this.writer = new ContentWriter(m, session);
    this.publish();
  }
  publish(): void {
    this.writer.assertHealthy();
    if (this.offeredRevision === this.buffer.revision) return;
    this.writer.offer(() => this.buffer.snapshot());
    this.offeredRevision = this.buffer.revision;
  }
  async close(): Promise<void> {
    this.buffer.unavailable();
    this.publish();
    await this.writer.close();
  }
}
