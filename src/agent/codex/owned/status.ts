import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { NATIVE_RUNTIME_MAX_BYTES } from '../../../runtime/projectionSchema.ts';
import { RuntimeStatusWriter, validateRuntimeLiveness } from '../../../runtime/statusFile.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { ownedCodexStatusPath } from './paths.ts';
import {
  type OwnedCodexRead,
  type OwnedCodexSnapshot,
  OwnedCodexSnapshotSchema,
} from './schema.ts';

export function unavailableOwnedCodex(reason: string): OwnedCodexRead {
  return { protocol: 1, status: 'unavailable', reason, snapshot: null };
}

export function validateOwnedCodex(
  bytes: string,
  identity: { machine: string; session: string; threadId: string },
  now = Date.now(),
): OwnedCodexRead {
  let snapshot: OwnedCodexSnapshot;
  try {
    snapshot = OwnedCodexSnapshotSchema.parse(JSON.parse(bytes));
  } catch {
    return unavailableOwnedCodex('invalid');
  }
  if (
    snapshot.machine !== identity.machine ||
    snapshot.session !== identity.session ||
    snapshot.threadId !== identity.threadId
  ) {
    return unavailableOwnedCodex('identity-mismatch');
  }
  return validateOwnedCodexLiveness(snapshot, now);
}

export function validateOwnedCodexLiveness(
  snapshot: OwnedCodexSnapshot,
  now = Date.now(),
): OwnedCodexRead {
  return validateRuntimeLiveness(snapshot, now);
}

/** Small local prepared file only; never inspect panes, provider history or a live RPC. */
export function readOwnedCodexStatus(
  m: Pick<MachineConfig, 'stateDir' | 'rcPrefix'>,
  s: Pick<Session, 'name' | 'uuid'>,
  now?: number,
): OwnedCodexRead {
  let fd: number | undefined;
  try {
    fd = openSync(
      ownedCodexStatusPath(m, s.name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    // The same rule as every other runtime's private state: no group or world access at all. This
    // one alone allowed group and world READ, and its owner has always written the file 0600.
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      return unavailableOwnedCodex('unauthorized');
    if (stat.size > NATIVE_RUNTIME_MAX_BYTES) return unavailableOwnedCodex('oversized');
    const bytes = Buffer.alloc(NATIVE_RUNTIME_MAX_BYTES + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > NATIVE_RUNTIME_MAX_BYTES) return unavailableOwnedCodex('oversized');
    return validateOwnedCodex(
      bytes.toString('utf8', 0, size),
      { machine: m.rcPrefix, session: s.name, threadId: s.uuid },
      now ?? Date.now(),
    );
  } catch {
    return unavailableOwnedCodex('unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The Codex owner's status writer. Its file stays where Codex owners have always written it
 *  (`ownedCodexStatusPath`): an owner outlives an update of ccmux, and the published
 *  `codex-runtime-reader` reads this path directly. */
export class OwnedCodexStatusWriter extends RuntimeStatusWriter<OwnedCodexSnapshot> {
  constructor(m: MachineConfig, name: string) {
    super(ownedCodexStatusPath(m, name), OwnedCodexSnapshotSchema);
  }
}
