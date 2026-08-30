import { join } from 'node:path';
import { withDirectoryLock } from '../config/registryLock.ts';
import type { MachineConfig } from '../types.ts';
import { AttachmentFault, assertAttachment, attachmentRefusal } from './errors.ts';
import {
  attachmentPath,
  attachmentRoot,
  checkPrivateLock,
  lstatExists,
  readPrivate,
  removePrivate,
  writePrivateJson,
} from './files.ts';
import { type AttachmentStore, AttachmentStoreSchema } from './schema.ts';

export type AttachmentTransaction = {
  root: string;
  store: AttachmentStore;
  persist: () => void;
};

const STORE_BYTES = 4 * 1024 * 1024;

function load(root: string): AttachmentStore {
  const path = join(root, 'index.json');
  if (!lstatExists(path)) return { version: 1, records: [], pins: [], cancelled: [] };
  return AttachmentStoreSchema.parse(JSON.parse(readPrivate(path, STORE_BYTES).toString('utf8')));
}

function reapExpired(tx: AttachmentTransaction, now: number): void {
  const protectedIds = new Set(
    tx.store.pins.flatMap((pin) => pin.references.map((reference) => reference.id)),
  );
  const expired = tx.store.records.filter(
    (row) => row.phase !== 'retained' && row.expiresAt <= now && !protectedIds.has(row.id),
  );
  const cancelled = tx.store.cancelled.filter((row) => row.expiresAt > now);
  if (!expired.length && cancelled.length === tx.store.cancelled.length) return;
  const expiredIds = new Set(expired.map((row) => row.id));
  for (const row of expired) removePrivate(attachmentPath(tx.root, row));
  tx.store.records = tx.store.records.filter((row) => !expiredIds.has(row.id));
  tx.store.cancelled = cancelled;
  tx.persist();
}

function recordFailure(root: string, operation: string, error: unknown): void {
  const reason =
    error instanceof AttachmentFault
      ? error.reason
      : error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error
          ? error.name
          : 'unknown';
  // Bounded owner-only evidence; no caller content, decoder output, filenames or exception text.
  writePrivateJson(root, 'last-failure.json', { at: new Date().toISOString(), operation, reason });
}

/** Lock order is session registry → attachment store. Accepted pins are never time-expired. */
export async function withAttachmentStore<T>(
  m: MachineConfig,
  operation: string,
  run: (tx: AttachmentTransaction) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let root: string | undefined;
  try {
    signal?.throwIfAborted();
    root = attachmentRoot(m);
    const ownedRoot = root;
    checkPrivateLock(join(ownedRoot, '.lock'));
    return await withDirectoryLock(
      join(ownedRoot, '.lock'),
      async () => {
        signal?.throwIfAborted();
        const store = load(ownedRoot);
        const tx: AttachmentTransaction = {
          root: ownedRoot,
          store,
          persist: () => {
            const parsed = AttachmentStoreSchema.parse(store);
            assertAttachment(
              Buffer.byteLength(JSON.stringify(parsed)) <= STORE_BYTES,
              'attachment-index-quota',
            );
            writePrivateJson(ownedRoot, 'index.json', parsed);
          },
        };
        reapExpired(tx, Date.now());
        return run(tx);
      },
      'attachment store',
    );
  } catch (error) {
    if (root !== undefined) {
      try {
        recordFailure(root, operation, error);
      } catch {
        /* Original refusal remains authoritative if storage is unavailable. */
      }
    }
    if (signal?.aborted) throw signal.reason;
    throw attachmentRefusal();
  }
}
