import { z } from 'zod';
import { machineConfigPath, resolveMonitoringLocation } from '../../config/monitoring-location.ts';
import { MonitoringFileError, readBoundedFile } from '../../monitoring/native-file.ts';
import { NATIVE_RUNTIME_MAX_BYTES } from '../../runtime/projectionSchema.ts';
import { ownedCodexStatusPath } from './ownedPaths.ts';
import type { OwnedCodexRead } from './ownedSchema.ts';
import {
  unavailableOwnedCodex,
  validateOwnedCodex,
  validateOwnedCodexLiveness,
} from './ownedStatus.ts';

export const OwnedCodexReadOptionsSchema = z
  .object({
    session: z.string().min(1).max(256),
    threadId: z.uuid(),
    timeoutMs: z.number().int().min(1).max(1000).optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
export type OwnedCodexReadOptions = z.infer<typeof OwnedCodexReadOptionsSchema>;

type Waiter = (result: OwnedCodexRead) => void;
const reads = new Map<string, { waiters: Set<Waiter>; active: Promise<OwnedCodexRead> }>();
let pending = 0;

async function readConfig(path: string): Promise<string> {
  try {
    return await readBoundedFile(path, 128 * 1024);
  } catch (error) {
    if (error instanceof MonitoringFileError && error.reason === 'missing') return '{}';
    throw error;
  }
}

async function readOnce(session: string, threadId: string): Promise<OwnedCodexRead> {
  try {
    const path = machineConfigPath();
    const config = await readConfig(path);
    const location = resolveMonitoringLocation(JSON.parse(config));
    const bytes = await readBoundedFile(
      ownedCodexStatusPath(location, session),
      NATIVE_RUNTIME_MAX_BYTES,
    );
    const after = await readConfig(path);
    const next = resolveMonitoringLocation(JSON.parse(after));
    if (
      path !== machineConfigPath() ||
      config !== after ||
      next.stateDir !== location.stateDir ||
      next.rcPrefix !== location.rcPrefix
    ) {
      return unavailableOwnedCodex('config-changed');
    }
    return validateOwnedCodex(bytes, { machine: location.rcPrefix, session, threadId });
  } catch (error) {
    return unavailableOwnedCodex(error instanceof MonitoringFileError ? error.reason : 'invalid');
  }
}

/** Supported resident read: exact session identity, no caller path, shell, provider RPC or scans. */
export function readCodexRuntime(input: OwnedCodexReadOptions): Promise<OwnedCodexRead> {
  const parsed = OwnedCodexReadOptionsSchema.safeParse(input);
  if (!parsed.success) return Promise.resolve(unavailableOwnedCodex('invalid'));
  const options = parsed.data;
  if (options.signal?.aborted) return Promise.resolve(unavailableOwnedCodex('cancelled'));
  if (pending >= 128 || reads.size >= 128) return Promise.resolve(unavailableOwnedCodex('busy'));
  const key = JSON.stringify([machineConfigPath(), options.session, options.threadId]);
  const timeoutMs = options.timeoutMs ?? 250;
  const deadline = performance.now() + timeoutMs;
  pending++;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: OwnedCodexRead) => {
      if (settled) return;
      settled = true;
      pending--;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      reads.get(key)?.waiters.delete(deliver);
      resolve(result);
    };
    const cancel = () => finish(unavailableOwnedCodex('cancelled'));
    const timer = setTimeout(() => finish(unavailableOwnedCodex('deadline')), timeoutMs);
    const deliver = (result: OwnedCodexRead) => {
      if (settled) return;
      if (options.signal?.aborted) return cancel();
      if (performance.now() >= deadline) return finish(unavailableOwnedCodex('deadline'));
      const checked =
        result.snapshot === null
          ? result
          : validateOwnedCodexLiveness(structuredClone(result.snapshot));
      finish(performance.now() >= deadline ? unavailableOwnedCodex('deadline') : checked);
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const active = reads.get(key);
    if (active !== undefined) {
      active.waiters.add(deliver);
      return;
    }
    const entry = {
      waiters: new Set([deliver]),
      active: readOnce(options.session, options.threadId),
    };
    reads.set(key, entry);
    void entry.active.then((result) => {
      reads.delete(key);
      for (const notify of entry.waiters) notify(result);
      entry.waiters.clear();
    });
  });
}
