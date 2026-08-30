import { samePrincipal, sameTarget } from '../chat/identity.ts';
import { withSessionRegistryLock } from '../config/registryLock.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';
import { assertAttachment } from './errors.ts';
import { attachmentPath, removePrivate } from './files.ts';
import {
  attachmentSession,
  ownedAttachment,
  readableAttachment,
  registration,
  verifiedReference,
} from './identity.ts';
import { previewBytes } from './preview.ts';
import { ATTACHMENT_LIMITS } from './reference.ts';
import {
  type AttachmentBegin,
  AttachmentBeginSchema,
  type AttachmentChunk,
  AttachmentChunkSchema,
  type AttachmentRead,
  AttachmentReadSchema,
  type AttachmentUploadSelector,
  AttachmentUploadSelectorSchema,
} from './schema.ts';
import { withAttachmentStore } from './store.ts';
import { appendUpload, beginUpload } from './upload.ts';

export { finalizeAttachmentUpload } from './finalize.ts';

export async function beginAttachmentUpload(
  m: MachineConfig,
  principal: ChatPrincipal,
  input: AttachmentBegin,
  signal: AbortSignal,
) {
  const parsed = AttachmentBeginSchema.parse(input);
  return withSessionRegistryLock(m, () =>
    withAttachmentStore(
      m,
      'begin',
      async (tx) => {
        const session = attachmentSession(m, parsed.target, true);
        return beginUpload(tx, session, principal, parsed);
      },
      signal,
    ),
  );
}

export async function appendAttachmentChunk(
  m: MachineConfig,
  principal: ChatPrincipal,
  input: AttachmentChunk,
  signal: AbortSignal,
) {
  const parsed = AttachmentChunkSchema.parse(input);
  return withSessionRegistryLock(m, () =>
    withAttachmentStore(
      m,
      'chunk',
      async (tx) => {
        const session = attachmentSession(m, parsed.target, true);
        return appendUpload(
          tx,
          ownedAttachment(tx, session, parsed.target, principal, parsed.uploadId),
          parsed,
        );
      },
      signal,
    ),
  );
}

export async function cancelAttachmentUpload(
  m: MachineConfig,
  principal: ChatPrincipal,
  input: AttachmentUploadSelector,
  signal: AbortSignal,
) {
  const parsed = AttachmentUploadSelectorSchema.parse(input);
  return withSessionRegistryLock(m, () =>
    withAttachmentStore(
      m,
      'cancel',
      async (tx) => {
        const session = attachmentSession(m, parsed.target, true);
        const cancelled = tx.store.cancelled.find((item) => item.id === parsed.uploadId);
        if (cancelled) {
          assertAttachment(
            cancelled.registration === registration(session) &&
              sameTarget(cancelled.target, parsed.target) &&
              samePrincipal(cancelled.principal, principal),
            'attachment-cancel-scope',
          );
          return { uploadId: parsed.uploadId, cancelled: true } satisfies {
            uploadId: string;
            cancelled: true;
          };
        }
        const row = ownedAttachment(tx, session, parsed.target, principal, parsed.uploadId);
        assertAttachment(
          row.phase !== 'retained' &&
            !tx.store.pins.some((pin) => pin.references.some((ref) => ref.id === row.id)),
          'attachment-retained',
        );
        assertAttachment(
          tx.store.cancelled.length < ATTACHMENT_LIMITS.records,
          'attachment-cancellation-quota',
        );
        tx.store.cancelled.push({
          id: row.id,
          target: row.target,
          registration: row.registration,
          principal: row.principal,
          expiresAt: Date.now() + ATTACHMENT_LIMITS.uploadTtlMs,
        });
        // Missing unretained bytes are safe to delete again if index persistence was interrupted.
        removePrivate(attachmentPath(tx.root, row));
        tx.store.records = tx.store.records.filter((item) => item.id !== row.id);
        tx.persist();
        return { uploadId: parsed.uploadId, cancelled: true } satisfies {
          uploadId: string;
          cancelled: true;
        };
      },
      signal,
    ),
  );
}

export async function readAttachmentChunk(
  m: MachineConfig,
  principal: ChatPrincipal,
  input: AttachmentRead,
  signal: AbortSignal,
) {
  const parsed = AttachmentReadSchema.parse(input);
  return withSessionRegistryLock(m, () =>
    withAttachmentStore(
      m,
      'read',
      async (tx) => {
        const session = attachmentSession(m, parsed.target, false);
        const row = readableAttachment(tx, session, parsed.target, principal, parsed.reference);
        const reference = verifiedReference(row, parsed.reference);
        assertAttachment(parsed.offset <= reference.bytes, 'attachment-read-offset');
        const bytes = previewBytes(attachmentPath(tx.root, row), reference, parsed.offset);
        const nextOffset = parsed.offset + bytes.length;
        return {
          reference,
          offset: parsed.offset,
          data: bytes.toString('base64'),
          nextOffset,
          complete: nextOffset === reference.bytes,
        };
      },
      signal,
    ),
  );
}
