import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { withDirectoryLock, withSessionRegistryLock } from '../config/registryLock.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';
import { decodeAttachment } from './decoder.ts';
import { assertAttachment } from './errors.ts';
import { attachmentPath, checkPrivateLock, readPrivate } from './files.ts';
import { attachmentSession, ownedAttachment, verifiedReference } from './identity.ts';
import { ATTACHMENT_LIMITS, AttachmentReferenceSchema } from './reference.ts';
import { type AttachmentUploadSelector, AttachmentUploadSelectorSchema } from './schema.ts';
import { withAttachmentStore } from './store.ts';

export async function finalizeAttachmentUpload(
  m: MachineConfig,
  principal: ChatPrincipal,
  input: AttachmentUploadSelector,
  signal: AbortSignal,
) {
  const parsed = AttachmentUploadSelectorSchema.parse(input);
  try {
    const root = await withAttachmentStore(m, 'finalize-admit', async (tx) => tx.root, signal);
    checkPrivateLock(join(root, '.decoder-lock'));
    return await withDirectoryLock(
      join(root, '.decoder-lock'),
      async () => {
        const prepared = await withSessionRegistryLock(m, () =>
          withAttachmentStore(
            m,
            'finalize-read',
            async (tx) => {
              const session = attachmentSession(m, parsed.target, true);
              const row = ownedAttachment(tx, session, parsed.target, principal, parsed.uploadId);
              if (row.phase !== 'uploading')
                return { reference: verifiedReference(row), bytes: null };
              assertAttachment(row.received === row.bytes, 'attachment-incomplete');
              const bytes = readPrivate(attachmentPath(tx.root, row), ATTACHMENT_LIMITS.imageBytes);
              assertAttachment(
                bytes.length === row.bytes &&
                  createHash('sha256').update(bytes).digest('hex') === row.digest,
                'attachment-digest',
              );
              return { reference: null, bytes };
            },
            signal,
          ),
        );
        if (prepared.reference !== null) return prepared.reference;
        assertAttachment(prepared.bytes !== null, 'attachment-decode-input');
        const image = await decodeAttachment(prepared.bytes, signal);
        return withSessionRegistryLock(m, () =>
          withAttachmentStore(
            m,
            'finalize-commit',
            async (tx) => {
              const session = attachmentSession(m, parsed.target, true);
              const row = ownedAttachment(tx, session, parsed.target, principal, parsed.uploadId);
              assertAttachment(
                row.phase === 'uploading' && row.received === row.bytes,
                'attachment-finalize-state',
              );
              const current = readPrivate(
                attachmentPath(tx.root, row),
                ATTACHMENT_LIMITS.imageBytes,
              );
              assertAttachment(
                current.equals(prepared.bytes) && image.mediaType === row.mediaType,
                'attachment-finalize-changed',
              );
              signal.throwIfAborted();
              row.reference = AttachmentReferenceSchema.parse({
                id: row.id,
                digest: row.digest,
                bytes: row.bytes,
                ...image,
              });
              row.phase = 'verified';
              row.expiresAt = Date.now() + ATTACHMENT_LIMITS.unretainedTtlMs;
              tx.persist();
              return row.reference;
            },
            signal,
          ),
        );
      },
      'attachment decoder',
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    return withAttachmentStore(
      m,
      'finalize',
      async () => {
        throw error;
      },
      signal,
    );
  }
}
