import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { dirname } from "node:path";
import type { MachineConfig, Session } from "../../types.ts";
import { atomicWrite } from "../../util/atomic.ts";
import { ownedCodexStatusPath, privateRuntimeDirectory } from "./ownedPaths.ts";
import { OwnedCodexSnapshotSchema, CODEX_RUNTIME_MAX_BYTES, CODEX_RUNTIME_TTL_MS,
  type OwnedCodexSnapshot, type OwnedCodexRead } from "./ownedSchema.ts";

export function unavailableOwnedCodex(reason: string): OwnedCodexRead {
  return { protocol: 1, status: "unavailable", reason, snapshot: null };
}

export function validateOwnedCodex(bytes: string, identity: { machine: string; session: string; threadId: string }, now = Date.now()): OwnedCodexRead {
  let snapshot: OwnedCodexSnapshot;
  try { snapshot = OwnedCodexSnapshotSchema.parse(JSON.parse(bytes)); }
  catch { return unavailableOwnedCodex("invalid"); }
  if (snapshot.machine !== identity.machine || snapshot.session !== identity.session || snapshot.threadId !== identity.threadId) {
    return unavailableOwnedCodex("identity-mismatch");
  }
  return validateOwnedCodexLiveness(snapshot, now);
}

export function validateOwnedCodexLiveness(snapshot: OwnedCodexSnapshot, now = Date.now()): OwnedCodexRead {
  for (const pid of [snapshot.pid, snapshot.providerPid]) {
    try { process.kill(pid, 0); }
    catch (error) {
      // A sandboxed resident reader may read the private projection but be denied kill(pid, 0).
      // EPERM is not proof of death: its positive state is still bounded by the producer's lease.
      if (error instanceof Error && "code" in error && error.code === "EPERM") continue;
      return unavailableOwnedCodex("producer-stopped");
    }
  }
  if (!snapshot.connected) return unavailableOwnedCodex(snapshot.reason ?? "disconnected");
  const observed = Date.parse(snapshot.observedAt);
  const expires = Date.parse(snapshot.expiresAt);
  if (now < observed || expires < observed || expires - observed > CODEX_RUNTIME_TTL_MS) return unavailableOwnedCodex("clock-skew");
  if (now >= expires) return { protocol: 1, status: "stale", reason: "expired", snapshot: null };
  return { protocol: 1, status: "live", reason: null, snapshot };
}

/** Small local prepared file only; never inspect panes, provider history or a live RPC. */
export function readOwnedCodexStatus(m: Pick<MachineConfig, "stateDir" | "rcPrefix">, s: Pick<Session, "name" | "uuid">, now?: number): OwnedCodexRead {
  let fd: number | undefined;
  try {
    fd = openSync(ownedCodexStatusPath(m, s.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) return unavailableOwnedCodex("unauthorized");
    if (stat.size > CODEX_RUNTIME_MAX_BYTES) return unavailableOwnedCodex("oversized");
    const bytes = Buffer.alloc(CODEX_RUNTIME_MAX_BYTES + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > CODEX_RUNTIME_MAX_BYTES) return unavailableOwnedCodex("oversized");
    return validateOwnedCodex(bytes.toString("utf8", 0, size), { machine: m.rcPrefix, session: s.name, threadId: s.uuid }, now ?? Date.now());
  } catch { return unavailableOwnedCodex("unavailable"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** A single coalesced write, bounded independently of provider token notifications. */
export class OwnedCodexStatusWriter {
  private next: OwnedCodexSnapshot | null = null;
  private writing: Promise<void> | null = null;

  constructor(private m: MachineConfig, private name: string) {
    privateRuntimeDirectory(dirname(ownedCodexStatusPath(m, name)));
  }

  write(snapshot: OwnedCodexSnapshot): Promise<void> {
    this.next = snapshot;
    this.writing ??= this.drain();
    return this.writing;
  }

  private async drain(): Promise<void> {
    // Set writing before even a synchronous validation failure can clear it. Clear it in the
    // same continuation as the final next check, not a later Promise.finally microtask that
    // could strand a newly queued snapshot behind an already-finished drain.
    await Promise.resolve();
    try {
      while (this.next !== null) {
        const snapshot = this.next;
        this.next = null;
        const bytes = JSON.stringify(OwnedCodexSnapshotSchema.parse(snapshot));
        if (Buffer.byteLength(bytes) > CODEX_RUNTIME_MAX_BYTES) throw new Error("Owned Codex projection exceeds its byte limit");
        await atomicWrite(ownedCodexStatusPath(this.m, this.name), bytes, 0o600);
      }
    } finally { this.writing = null; }
  }
}
