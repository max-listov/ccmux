import type { CodexRpcEvent, CodexRpcRequest } from '../rpc.ts';

const MAX_EVENTS = 128;
const MAX_REQUESTS = 16;
const MAX_EVENT_BYTES = 448 * 1024;
const MAX_BYTES = 512 * 1024;

const isDelta = (method: string): boolean =>
  method.endsWith('/delta') || method.endsWith('/summaryTextDelta');

/**
 * What the server says between opening the connection and admitting the thread.
 *
 * Events are registered before `thread/start` or `thread/resume`, so the ones that arrive in between
 * are held here and replayed once the projection exists — a snapshot that raced a newer event must
 * never overwrite it. The window is bounded: streamed text is shed first and counted, because the
 * content feed can say how much it lost; anything else that does not fit fails admission, because a
 * lost state change cannot be said at all.
 */
export class AdmissionBacklog {
  events: CodexRpcEvent[] = [];
  requests: CodexRpcRequest[] = [];
  /** Streamed deltas shed to stay inside the window. */
  omitted = 0;
  private bytes = 0;

  /** Hold an event; an error when it cannot be held and is not a delta that may be shed. */
  event(event: CodexRpcEvent): Error | null {
    const size = Buffer.byteLength(JSON.stringify(event));
    const full = () => this.events.length >= MAX_EVENTS || this.bytes + size > MAX_EVENT_BYTES;
    while (full()) {
      const index = this.events.findIndex((item) => isDelta(item.method));
      if (index < 0) break;
      const removed = this.events.splice(index, 1)[0];
      if (removed) {
        this.bytes -= Buffer.byteLength(JSON.stringify(removed));
        this.omitted++;
      }
    }
    if (!full()) {
      this.events.push(event);
      this.bytes += size;
      return null;
    }
    if (isDelta(event.method)) {
      this.omitted++;
      return null;
    }
    return new Error('Native admission event window overflow');
  }

  /** Hold a server request; an error when the window cannot. */
  request(request: CodexRpcRequest): Error | null {
    this.bytes += Buffer.byteLength(JSON.stringify(request));
    if (this.requests.length >= MAX_REQUESTS || this.bytes > MAX_BYTES)
      return new Error('Native request admission window overflow');
    this.requests.push(request);
    return null;
  }

  clear(): void {
    this.events = [];
    this.requests = [];
    this.bytes = 0;
  }
}
