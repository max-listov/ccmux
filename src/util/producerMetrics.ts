/** Process-local producer diagnostics share the daemon performance read channel. */
class ProducerMetrics {
  private readers = new Map<string, () => Record<string, number>>();

  register(name: string, read: () => Record<string, number>): void {
    if (this.readers.has(name)) throw new Error(`Duplicate producer metrics: ${name}`);
    this.readers.set(name, read);
  }

  snapshot(): Record<string, Record<string, number>> {
    return Object.fromEntries([...this.readers].map(([name, read]) => [name, { ...read() }]));
  }
}

export const producerMetrics = new ProducerMetrics();
