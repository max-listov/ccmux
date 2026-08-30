// In a consuming package: import { readMonitoringStatus } from "ccmux/monitoring-reader";
import { readMonitoringStatus } from '../src/monitoring-reader.ts';

const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());

while (!stop.signal.aborted) {
  const result = await readMonitoringStatus({ signal: stop.signal, timeoutMs: 250 });
  // Use identities from snapshot, never infer identity or live state from display text.
  console.log(JSON.stringify(result));
  if (!stop.signal.aborted) await Bun.sleep(2000);
}
