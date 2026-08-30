import { z } from 'zod';
import { machineConfigPath, resolveMonitoringLocation } from '../config/monitoring-location.ts';
import { monitoringStatusPath } from '../config/paths.ts';
import { MonitoringFileError, readBoundedFile } from './native-file.ts';
import { type MonitoringRead, STATUS_MAX_BYTES } from './schema.ts';
import { unavailable, validateLiveness, validateSnapshot } from './validate.ts';

export const MONITORING_CONFIG_MAX_BYTES = 128 * 1024;
export const MONITORING_MAX_READERS = 128;
export const MONITORING_DEFAULT_TIMEOUT_MS = 250;
export const MONITORING_MAX_TIMEOUT_MS = 1000;

const ReadOptionsSchema = z
  .object({
    signal: z.instanceof(AbortSignal).optional(),
    timeoutMs: z.number().min(1).max(MONITORING_MAX_TIMEOUT_MS).optional(),
  })
  .strict();
export type MonitoringReadOptions = z.infer<typeof ReadOptionsSchema>;

let active: Promise<MonitoringRead> | undefined;
const pending = new Set<(result: MonitoringRead) => void>();

async function readConfig(path: string): Promise<string> {
  try {
    return await readBoundedFile(path, MONITORING_CONFIG_MAX_BYTES);
  } catch (error) {
    if (error instanceof MonitoringFileError && error.reason === 'missing') return '{}';
    throw error;
  }
}

async function readOnce(): Promise<MonitoringRead> {
  try {
    const configPath = machineConfigPath();
    const config = await readConfig(configPath);
    const location = resolveMonitoringLocation(JSON.parse(config));
    const bytes = await readBoundedFile(monitoringStatusPath(location), STATUS_MAX_BYTES);
    // Do not deliver a snapshot read across a configuration/root switch. No retry or fallback.
    const after = await readConfig(configPath);
    const next = resolveMonitoringLocation(JSON.parse(after));
    if (
      configPath !== machineConfigPath() ||
      config !== after ||
      next.stateDir !== location.stateDir ||
      next.rcPrefix !== location.rcPrefix
    ) {
      return unavailable('config-changed');
    }
    return validateSnapshot(bytes, location.rcPrefix);
  } catch (error) {
    return unavailable(error instanceof MonitoringFileError ? error.reason : 'invalid');
  }
}

/** Supported resident read door. No path/refresh/command options and no subprocesses. */
export function readMonitoringStatus(options: MonitoringReadOptions = {}): Promise<MonitoringRead> {
  const parsed = ReadOptionsSchema.safeParse(options);
  if (!parsed.success) return Promise.resolve(unavailable('invalid'));
  options = parsed.data;
  const timeoutMs = options.timeoutMs ?? MONITORING_DEFAULT_TIMEOUT_MS;
  if (options.signal?.aborted) return Promise.resolve(unavailable('cancelled'));
  if (pending.size >= MONITORING_MAX_READERS) return Promise.resolve(unavailable('busy'));
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: MonitoringRead) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      pending.delete(deliver);
      resolve(result);
    };
    const cancel = () => finish(unavailable('cancelled'));
    const timer = setTimeout(() => finish(unavailable('deadline')), timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    const deliver = (result: MonitoringRead) => {
      if (settled) return;
      if (options.signal?.aborted) return cancel();
      if (performance.now() >= deadline) return finish(unavailable('deadline'));
      const delivered = result.snapshot
        ? validateLiveness(structuredClone(result.snapshot))
        : result;
      finish(performance.now() >= deadline ? unavailable('deadline') : delivered);
    };
    pending.add(deliver);
    // Exactly one completion handler even if callers repeatedly cancel while I/O is stuck.
    // Timed-out callers are removed from the bounded set, not retained on a pending promise.
    if (!active) {
      active = readOnce();
      void active.then((result) => {
        active = undefined;
        for (const notify of [...pending]) notify(result);
      });
    }
  });
}
