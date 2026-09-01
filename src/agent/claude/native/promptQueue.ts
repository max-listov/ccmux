import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** A queue the runtime pulls turns from. One long-lived session, not one process per turn. */
export class PromptQueue {
  private waiting: ((value: IteratorResult<SDKUserMessage>) => void)[] = [];
  private pending: SDKUserMessage[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    const next = this.waiting.shift();
    if (next) next({ value: message, done: false });
    else this.pending.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined as never, done: true });
  }

  iterable(): AsyncIterable<SDKUserMessage> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const ready = this.pending.shift();
          if (ready) return Promise.resolve({ value: ready, done: false });
          if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<SDKUserMessage>>((resolve) =>
            this.waiting.push(resolve),
          );
        },
      }),
    };
  }
}
