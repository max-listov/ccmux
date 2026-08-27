import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { monitoringStatusPath } from "../config/paths.ts";
import type { MachineConfig } from "../types.ts";
import { MonitoringSnapshotSchema, STATUS_MAX_AGE_MS, STATUS_MAX_BYTES, type MonitoringRead } from "./schema.ts";

/** One fixed file, one bounded read; no registry, transcript, subprocess or producer startup. */
export function readMonitoringStatus(m: MachineConfig, now = Date.now()): MonitoringRead {
  const unavailable = (reason: MonitoringRead["reason"]): MonitoringRead => ({ protocol: 1, status: "unavailable", reason, snapshot: null });
  let fd: number;
  try { fd = openSync(monitoringStatusPath(m), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) { return unavailable(error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "read-failed"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return unavailable("invalid");
    if (stat.size > STATUS_MAX_BYTES) return unavailable("oversized");
    const bytes = Buffer.alloc(STATUS_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > STATUS_MAX_BYTES) return unavailable("oversized");
    const result = MonitoringSnapshotSchema.safeParse(JSON.parse(bytes.toString("utf8", 0, length)));
    if (!result.success || result.data.rcPrefix !== m.rcPrefix) return unavailable("invalid");
    const snapshot = result.data;
    const age = now - Date.parse(snapshot.observedAt);
    if (age < 0) return { protocol: 1, status: "stale", reason: "clock-skew", snapshot: null };
    if (age > STATUS_MAX_AGE_MS) return { protocol: 1, status: "stale", reason: "expired", snapshot: null };
    try { process.kill(snapshot.pid, 0); } catch { return unavailable("producer-stopped"); }
    return { protocol: 1, status: "live", reason: null, snapshot };
  } catch { return unavailable("invalid"); }
  finally { closeSync(fd); }
}
