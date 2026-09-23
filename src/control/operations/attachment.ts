import type { z } from 'zod';
import type {
  AttachmentBeginSchema,
  AttachmentChunkSchema,
  AttachmentReadSchema,
  AttachmentUploadSelectorSchema,
} from '../../attachments/schema.ts';
import {
  appendAttachmentChunk,
  beginAttachmentUpload,
  cancelAttachmentUpload,
  finalizeAttachmentUpload,
  readAttachmentChunk,
} from '../../attachments/service.ts';
import type { ChatPrincipal } from '../../types.ts';
import type { OperationContext } from './context.ts';
import { controlRefusal } from './refusal.ts';

/** Attachment upload and read, chunked and bounded. */
export function attachmentOperations(context: OperationContext) {
  const { m, mutations, reads } = context;
  return {
    attachmentBegin: (
      input: z.output<typeof AttachmentBeginSchema>,
      principal: ChatPrincipal,
      signal?: AbortSignal,
    ) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => beginAttachmentUpload(m, principal, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 10_000 },
        )
        .catch(controlRefusal),
    attachmentChunk: (
      input: z.output<typeof AttachmentChunkSchema>,
      principal: ChatPrincipal,
      signal?: AbortSignal,
    ) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => appendAttachmentChunk(m, principal, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 10_000 },
        )
        .catch(controlRefusal),
    attachmentFinalize: (
      input: z.output<typeof AttachmentUploadSelectorSchema>,
      principal: ChatPrincipal,
      signal?: AbortSignal,
    ) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => finalizeAttachmentUpload(m, principal, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 10_000 },
        )
        .catch(controlRefusal),
    attachmentCancel: (
      input: z.output<typeof AttachmentUploadSelectorSchema>,
      principal: ChatPrincipal,
      signal?: AbortSignal,
    ) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => cancelAttachmentUpload(m, principal, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 10_000 },
        )
        .catch(controlRefusal),
    attachmentRead: (
      input: z.output<typeof AttachmentReadSchema>,
      principal: ChatPrincipal,
      signal?: AbortSignal,
    ) =>
      reads
        .run(
          undefined,
          ({ signal: admitted }) => readAttachmentChunk(m, principal, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 5_000 },
        )
        .catch(controlRefusal),
  };
}
