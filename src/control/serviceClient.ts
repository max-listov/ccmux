import { ApiError, type ClientFetch, createClient } from 'stitchkit';
import { defineContract } from 'stitchkit/contract';
import { z } from 'zod';
import { AttachmentReferenceSchema } from '../attachments/reference.ts';
import {
  AttachmentBeginSchema,
  AttachmentCancelReceiptSchema,
  AttachmentChunkSchema,
  AttachmentReadReceiptSchema,
  AttachmentReadSchema,
  AttachmentUploadReceiptSchema,
  AttachmentUploadSelectorSchema,
} from '../attachments/schema.ts';
import { NativeForkRequestSchema } from '../context/schema.ts';
import { RuntimeCatalogInputSchema, RuntimeCatalogSchema } from '../runtime/capabilities.ts';
import {
  SteeringInputSchema,
  SteeringReadResultSchema,
  SteeringReceiptSchema,
  SteeringSelectorSchema,
} from '../steering/schema.ts';
import {
  ControlCompactSchema,
  ControlContextOperationReadSchema,
  ControlContextOperationResultSchema,
  ControlHistoryReadSchema,
  ControlHistoryResultSchema,
} from './contextSchema.ts';
import { ControlDirectoryReadSchema, ControlDirectoryResultSchema } from './directorySchema.ts';
import {
  ControlActionReceiptSchema,
  ControlArchiveReceiptSchema,
  ControlCreateReceiptSchema,
  ControlCreateSchema,
  ControlInterruptSchema,
  ControlMessageReceiptSchema,
  ControlMessageSchema,
  ControlModelCatalogSchema,
  ControlModelsReadSchema,
  ControlNativeReadSchema,
  ControlNativeResponseReceiptSchema,
  ControlNativeResponseSchema,
  ControlNativeSnapshotSchema,
  ControlRowSchema,
  ControlTargetSchema,
  ControlWaitResultSchema,
} from './schema.ts';
import {
  SelectionReadSchema,
  SelectionResultSchema,
  SelectionUpdateSchema,
} from './selectionSchema.ts';
import {
  CCMUX_CONTROL_SERVICE_BASE_URL,
  CCMUX_CONTROL_SERVICE_PREFIX,
  ControlServiceOperationSchema,
  ControlServiceReplyEnvelopeSchema,
  ControlServiceWaitSchema,
  controlServiceEffects,
  controlServiceInputs,
} from './serviceCatalog.ts';
import { serviceOperation } from './serviceDescriptor.ts';

function serviceReply<T>(result: z.ZodType<T>) {
  return ControlServiceReplyEnvelopeSchema.transform((envelope, ctx): T => {
    const parsed = result.safeParse(envelope.result);
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', message: 'owner service returned an invalid result' });
      return z.NEVER;
    }
    return parsed.data;
  });
}

export const ccmuxControlServiceContract = defineContract(
  { prefix: CCMUX_CONTROL_SERVICE_PREFIX },
  {
    history: {
      method: 'POST',
      path: '/history.read',
      desc: 'Read a bounded native history page',
      input: ControlHistoryReadSchema,
      output: serviceReply(ControlHistoryResultSchema),
      idempotent: true,
      timeout: 7_000,
      meta: { effect: controlServiceEffects['history.read'] },
    },
    compact: {
      method: 'POST',
      path: '/context.compact',
      desc: 'Accept exact idle native compaction',
      input: ControlCompactSchema,
      output: serviceReply(ControlContextOperationResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['context.compact'] },
    },
    contextOperation: {
      method: 'POST',
      path: '/context.operation',
      desc: 'Read durable compaction evidence',
      input: ControlContextOperationReadSchema,
      output: serviceReply(ControlContextOperationResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['context.operation'] },
    },
    fork: {
      method: 'POST',
      path: '/session.fork',
      desc: 'Fork an exact idle native conversation',
      input: NativeForkRequestSchema,
      output: serviceReply(ControlCreateReceiptSchema),
      idempotent: true,
      timeout: 30_000,
      meta: { effect: controlServiceEffects['session.fork'] },
    },
    steer: {
      method: 'POST',
      path: '/turn.steer',
      desc: 'Submit content to an exact active native turn',
      input: SteeringInputSchema,
      output: serviceReply(SteeringReceiptSchema),
      idempotent: true,
      timeout: 15_000,
      meta: { effect: controlServiceEffects['turn.steer'] },
    },
    steeringOperation: {
      method: 'POST',
      path: '/turn.steering-operation',
      desc: 'Read exact steering acceptance',
      input: SteeringSelectorSchema,
      output: serviceReply(SteeringReadResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['turn.steering-operation'] },
    },
    selection: {
      method: 'POST',
      path: '/selection.read',
      desc: 'Read revisioned native turn defaults for an exact registration',
      input: SelectionReadSchema,
      output: serviceReply(SelectionResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['selection.read'] },
    },
    select: {
      method: 'POST',
      path: '/selection.update',
      desc: 'Compare-and-swap native turn defaults between turns',
      input: SelectionUpdateSchema,
      output: serviceReply(SelectionResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['selection.update'] },
    },
    attachmentBegin: {
      method: 'POST',
      path: '/attachment.begin',
      desc: 'Reserve an authenticated bounded image upload',
      input: AttachmentBeginSchema,
      output: serviceReply(AttachmentUploadReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['attachment.begin'] },
    },
    attachmentChunk: {
      method: 'POST',
      path: '/attachment.chunk',
      desc: 'Append one authenticated bounded image chunk',
      input: AttachmentChunkSchema,
      output: serviceReply(AttachmentUploadReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['attachment.chunk'] },
    },
    attachmentFinalize: {
      method: 'POST',
      path: '/attachment.finalize',
      desc: 'Decode and verify complete image bytes',
      input: AttachmentUploadSelectorSchema,
      output: serviceReply(AttachmentReferenceSchema),
      idempotent: true,
      timeout: 15_000,
      meta: { effect: controlServiceEffects['attachment.finalize'] },
    },
    attachmentCancel: {
      method: 'POST',
      path: '/attachment.cancel',
      desc: 'Cancel only unretained image bytes',
      input: AttachmentUploadSelectorSchema,
      output: serviceReply(AttachmentCancelReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['attachment.cancel'] },
    },
    attachmentRead: {
      method: 'POST',
      path: '/attachment.read',
      desc: 'Read an authenticated bounded image preview',
      input: AttachmentReadSchema,
      output: serviceReply(AttachmentReadReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['attachment.read'] },
    },
    runtimes: {
      method: 'POST',
      path: '/runtime.list',
      desc: 'Discover configured execution runtimes and capabilities',
      input: RuntimeCatalogInputSchema,
      output: serviceReply(RuntimeCatalogSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['runtime.list'] },
    },
    get: {
      method: 'POST',
      path: '/session.get',
      desc: 'Read one exact managed session',
      input: ControlTargetSchema,
      output: serviceReply(ControlRowSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['session.get'] },
    },
    directories: {
      method: 'POST',
      path: '/directory.list',
      desc: 'Read a bounded directory page',
      input: ControlDirectoryReadSchema,
      output: serviceReply(ControlDirectoryResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['directory.list'] },
    },
    create: {
      method: 'POST',
      path: '/session.create',
      desc: 'Idempotently create one managed Codex session',
      input: ControlCreateSchema,
      output: serviceReply(ControlCreateReceiptSchema),
      idempotent: true,
      timeout: 30_000,
      meta: { effect: controlServiceEffects['session.create'] },
    },
    archive: {
      method: 'POST',
      path: '/session.archive',
      desc: 'Archive one exact managed identity',
      input: ControlTargetSchema,
      output: serviceReply(ControlArchiveReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['session.archive'] },
    },
    message: {
      method: 'POST',
      path: '/message.send',
      desc: 'Accept one identity-pinned durable message',
      input: ControlMessageSchema,
      output: serviceReply(ControlMessageReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['message.send'] },
    },
    start: {
      method: 'POST',
      path: '/session.start',
      desc: 'Start one existing managed identity',
      input: ControlTargetSchema,
      output: serviceReply(ControlActionReceiptSchema),
      meta: { effect: controlServiceEffects['session.start'] },
    },
    interrupt: {
      method: 'POST',
      path: '/turn.interrupt',
      desc: 'Interrupt one exact active native turn',
      input: ControlInterruptSchema,
      output: serviceReply(ControlActionReceiptSchema),
      meta: { effect: controlServiceEffects['turn.interrupt'] },
    },
    native: {
      method: 'POST',
      path: '/native.read',
      desc: 'Read bounded native items after a cursor',
      input: ControlNativeReadSchema,
      output: serviceReply(ControlNativeSnapshotSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['native.read'] },
    },
    respond: {
      method: 'POST',
      path: '/native.respond',
      desc: 'Answer one exact current native request',
      input: ControlNativeResponseSchema,
      output: serviceReply(ControlNativeResponseReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['native.respond'] },
    },
    wait: {
      method: 'POST',
      path: '/session.wait',
      desc: 'Wait for a managed native session between turns',
      input: ControlServiceWaitSchema,
      output: serviceReply(ControlWaitResultSchema),
      idempotent: true,
      timeout: 30_000,
      meta: { effect: controlServiceEffects['session.wait'] },
    },
    models: {
      method: 'POST',
      path: '/model.list',
      desc: 'Read the connected App Server model catalog after an optional cursor',
      input: ControlModelsReadSchema,
      output: serviceReply(ControlModelCatalogSchema),
      idempotent: true,
      timeout: 10_000,
      meta: { effect: controlServiceEffects['model.list'] },
    },
  },
);

/** The composing transport supplies delivery. No socket, credential or retry is implicit. */
export function createCcmuxControlServiceClient(fetch: ClientFetch, timeoutMs = 30_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
    throw new Error('Invalid client deadline');
  return createClient(ccmuxControlServiceContract, {
    baseUrl: CCMUX_CONTROL_SERVICE_BASE_URL,
    timeout: timeoutMs,
    fetch: async (url, init) => {
      const route = new URL(String(url));
      if (
        route.origin !== CCMUX_CONTROL_SERVICE_BASE_URL ||
        !route.pathname.startsWith(`${CCMUX_CONTROL_SERVICE_PREFIX}/`) ||
        route.search !== '' ||
        init?.method !== 'POST'
      )
        throw new ApiError('INVALID_OPERATION');
      const operation = ControlServiceOperationSchema.parse(
        route.pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
      );
      const body = typeof init.body === 'string' ? init.body : '{}';
      const limit = serviceOperation(operation).limits.requestBytes;
      if (new TextEncoder().encode(body).byteLength > limit)
        throw new ApiError('REQUEST_TOO_LARGE');
      let decoded: unknown;
      try {
        decoded = JSON.parse(body);
      } catch {
        throw new ApiError('INVALID_INPUT');
      }
      const parsed = controlServiceInputs[operation].safeParse(decoded);
      if (!parsed.success) throw new ApiError('INVALID_INPUT');
      return fetch(url, { ...init, body: JSON.stringify(parsed.data) });
    },
  });
}

export type { ClientFetch } from 'stitchkit';
export { ApiError } from 'stitchkit';
