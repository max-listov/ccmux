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
import {
  MessageOperationReadSchema,
  MessageOperationResultSchema,
} from '../chat/messageOperationSchema.ts';
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
  CONTROL_MAX_BYTES,
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
  ControlWaitSchema,
} from './schema.ts';
import {
  SelectionReadSchema,
  SelectionResultSchema,
  SelectionUpdateSchema,
} from './selectionSchema.ts';

export const CCMUX_CONTROL_SERVICE_ID = 'ccmux.control';
export const CCMUX_CONTROL_SERVICE_REVISION = 'current';
export const CCMUX_CONTROL_SERVICE_BASE_URL = 'https://ccmux.invalid';
export const CCMUX_CONTROL_SERVICE_PREFIX = '/ccmux/control';
export const CCMUX_CONTROL_SERVICE_INGRESS_PATH = '/ccmux-control/invoke';
export const CCMUX_CONTROL_SERVICE_MAX_REQUEST_BYTES = 64 * 1024;
export const CCMUX_CONTROL_SERVICE_MAX_RESPONSE_BYTES = CONTROL_MAX_BYTES + 4096;

export const ControlServiceOperationSchema = z.enum([
  'message.operation',
  'history.read',
  'context.compact',
  'context.operation',
  'session.fork',
  'turn.steer',
  'turn.steering-operation',
  'selection.read',
  'selection.update',
  'attachment.begin',
  'attachment.chunk',
  'attachment.finalize',
  'attachment.cancel',
  'attachment.read',
  'runtime.list',
  'session.get',
  'session.create',
  'session.archive',
  'message.send',
  'session.start',
  'turn.interrupt',
  'native.read',
  'native.respond',
  'session.wait',
  'model.list',
  'directory.list',
]);
export type ControlServiceOperation = z.infer<typeof ControlServiceOperationSchema>;

export const ControlServiceEffectSchema = z
  .enum([
    'message.read',
    'history.read',
    'context.write',
    'context.read',
    'session.fork',
    'turn.steer',
    'turn.steering.read',
    'selection.read',
    'selection.write',
    'attachment.write',
    'attachment.read',
    'runtime.read',
    'session.read',
    'session.create',
    'session.archive',
    'message.send',
    'session.start',
    'turn.interrupt',
    'native.read',
    'native.respond',
    'session.wait',
    'model.read',
    'directory.read',
  ])
  .refine((effect) => /^[a-z0-9][a-z0-9._-]*$/.test(effect), 'invalid service effect identifier');
export type ControlServiceEffect = z.infer<typeof ControlServiceEffectSchema>;

export const controlServiceEffects = {
  'message.operation': 'message.read',
  'history.read': 'history.read',
  'context.compact': 'context.write',
  'context.operation': 'context.read',
  'session.fork': 'session.fork',
  'turn.steer': 'turn.steer',
  'turn.steering-operation': 'turn.steering.read',
  'selection.read': 'selection.read',
  'selection.update': 'selection.write',
  'attachment.begin': 'attachment.write',
  'attachment.chunk': 'attachment.write',
  'attachment.finalize': 'attachment.write',
  'attachment.cancel': 'attachment.write',
  'attachment.read': 'attachment.read',
  'runtime.list': 'runtime.read',
  'session.get': 'session.read',
  'session.create': 'session.create',
  'session.archive': 'session.archive',
  'message.send': 'message.send',
  'session.start': 'session.start',
  'turn.interrupt': 'turn.interrupt',
  'native.read': 'native.read',
  'native.respond': 'native.respond',
  'session.wait': 'session.wait',
  'model.list': 'model.read',
  'directory.list': 'directory.read',
} satisfies Record<ControlServiceOperation, ControlServiceEffect>;

export const ControlServiceReplyEnvelopeSchema = z
  .object({
    v: z.literal(1),
    revision: z.literal(CCMUX_CONTROL_SERVICE_REVISION),
    result: z.unknown(),
  })
  .strict();

export const ControlServiceWaitSchema = ControlWaitSchema.extend({
  timeoutMs: z.number().int().min(1).max(25_000).default(25_000),
}).strict();

export const controlServiceInputs = {
  'message.operation': MessageOperationReadSchema,
  'history.read': ControlHistoryReadSchema,
  'context.compact': ControlCompactSchema,
  'context.operation': ControlContextOperationReadSchema,
  'session.fork': NativeForkRequestSchema,
  'turn.steer': SteeringInputSchema,
  'turn.steering-operation': SteeringSelectorSchema,
  'selection.read': SelectionReadSchema,
  'selection.update': SelectionUpdateSchema,
  'attachment.begin': AttachmentBeginSchema,
  'attachment.chunk': AttachmentChunkSchema,
  'attachment.finalize': AttachmentUploadSelectorSchema,
  'attachment.cancel': AttachmentUploadSelectorSchema,
  'attachment.read': AttachmentReadSchema,
  'runtime.list': RuntimeCatalogInputSchema,
  'session.get': ControlTargetSchema,
  'session.create': ControlCreateSchema,
  'session.archive': ControlTargetSchema,
  'message.send': ControlMessageSchema,
  'session.start': ControlTargetSchema,
  'turn.interrupt': ControlInterruptSchema,
  'native.read': ControlNativeReadSchema,
  'native.respond': ControlNativeResponseSchema,
  'session.wait': ControlServiceWaitSchema,
  'model.list': ControlModelsReadSchema,
  'directory.list': ControlDirectoryReadSchema,
};

export const controlServiceOutputs = {
  'message.operation': MessageOperationResultSchema,
  'history.read': ControlHistoryResultSchema,
  'context.compact': ControlContextOperationResultSchema,
  'context.operation': ControlContextOperationResultSchema,
  'session.fork': ControlCreateReceiptSchema,
  'turn.steer': SteeringReceiptSchema,
  'turn.steering-operation': SteeringReadResultSchema,
  'selection.read': SelectionResultSchema,
  'selection.update': SelectionResultSchema,
  'attachment.begin': AttachmentUploadReceiptSchema,
  'attachment.chunk': AttachmentUploadReceiptSchema,
  'attachment.finalize': AttachmentReferenceSchema,
  'attachment.cancel': AttachmentCancelReceiptSchema,
  'attachment.read': AttachmentReadReceiptSchema,
  'runtime.list': RuntimeCatalogSchema,
  'session.get': ControlRowSchema,
  'session.create': ControlCreateReceiptSchema,
  'session.archive': ControlArchiveReceiptSchema,
  'message.send': ControlMessageReceiptSchema,
  'session.start': ControlActionReceiptSchema,
  'turn.interrupt': ControlActionReceiptSchema,
  'native.read': ControlNativeSnapshotSchema,
  'native.respond': ControlNativeResponseReceiptSchema,
  'session.wait': ControlWaitResultSchema,
  'model.list': ControlModelCatalogSchema,
  'directory.list': ControlDirectoryResultSchema,
};
