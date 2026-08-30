import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { monitoringStatusPath } from '../config/paths.ts';
import type { MachineConfig } from '../types.ts';
import { type MonitoringRead, STATUS_MAX_BYTES } from './schema.ts';
import { unavailable, validateSnapshot } from './validate.ts';

/** One fixed file, one bounded read; no registry, transcript, subprocess or producer startup. */
export function readMonitoringStatus(m: MachineConfig, now = Date.now()): MonitoringRead {
  let fd: number;
  try {
    fd = openSync(
      monitoringStatusPath(m),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    return unavailable(
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? 'missing'
        : 'read-failed',
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return unavailable('invalid');
    if (stat.size > STATUS_MAX_BYTES) return unavailable('oversized');
    const bytes = Buffer.alloc(STATUS_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > STATUS_MAX_BYTES) return unavailable('oversized');
    return validateSnapshot(bytes.toString('utf8', 0, length), m.rcPrefix, now);
  } catch {
    return unavailable('invalid');
  } finally {
    closeSync(fd);
  }
}
