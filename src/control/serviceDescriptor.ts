import { z } from 'zod';
import { RC_PREFIX_RE } from '../config/schema.ts';
import { CONTROL_MAX_BYTES } from './schema.ts';
import {
  CCMUX_CONTROL_SERVICE_BASE_URL,
  CCMUX_CONTROL_SERVICE_ID,
  CCMUX_CONTROL_SERVICE_MAX_REQUEST_BYTES,
  CCMUX_CONTROL_SERVICE_MAX_RESPONSE_BYTES,
  CCMUX_CONTROL_SERVICE_PREFIX,
  CCMUX_CONTROL_SERVICE_REVISION,
  ControlServiceEffectSchema,
  type ControlServiceOperation,
  ControlServiceOperationSchema,
  controlServiceEffects,
} from './serviceCatalog.ts';

export * from './serviceCatalog.ts';
export {
  ApiError,
  type ClientFetch,
  ccmuxControlServiceContract,
  createCcmuxControlServiceClient,
} from './serviceClient.ts';

const ControlServiceLimitsSchema = z
  .object({
    requestBytes: z.number().int().positive().max(CCMUX_CONTROL_SERVICE_MAX_REQUEST_BYTES),
    responseBytes: z.number().int().positive().max(CCMUX_CONTROL_SERVICE_MAX_RESPONSE_BYTES),
    timeoutMs: z.number().int().min(1_000).max(30_000),
  })
  .strict();

export const ControlServiceDescriptorSchema = z
  .object({
    service: z.literal(CCMUX_CONTROL_SERVICE_ID),
    revision: z.literal(CCMUX_CONTROL_SERVICE_REVISION),
    maxInflight: z.literal(8),
    operations: z
      .array(
        z
          .object({
            id: ControlServiceOperationSchema,
            effect: ControlServiceEffectSchema,
            limits: ControlServiceLimitsSchema,
          })
          .strict(),
      )
      .length(ControlServiceOperationSchema.options.length),
  })
  .strict()
  .superRefine((descriptor, ctx) => {
    const seen = new Set<string>();
    for (const operation of descriptor.operations) {
      if (seen.has(operation.id))
        ctx.addIssue({
          code: 'custom',
          path: ['operations'],
          message: `duplicate operation ${operation.id}`,
        });
      seen.add(operation.id);
      if (operation.effect !== controlServiceEffect(operation.id))
        ctx.addIssue({
          code: 'custom',
          path: ['operations'],
          message: `wrong effect for ${operation.id}`,
        });
    }
  });

export const ccmuxControlServiceDescriptor = ControlServiceDescriptorSchema.parse({
  service: CCMUX_CONTROL_SERVICE_ID,
  revision: CCMUX_CONTROL_SERVICE_REVISION,
  maxInflight: 8,
  operations: [
    {
      id: 'external.history',
      effect: 'external.content.read',
      limits: { requestBytes: 8192, responseBytes: 384 * 1024, timeoutMs: 7000 },
    },
    {
      id: 'external.capabilities',
      effect: 'external.content.read',
      limits: { requestBytes: 4096, responseBytes: 8192, timeoutMs: 7000 },
    },
    {
      id: 'message.operation',
      effect: controlServiceEffects['message.operation'],
      limits: { requestBytes: 8192, responseBytes: 8192, timeoutMs: 5000 },
    },
    {
      id: 'history.read',
      effect: controlServiceEffects['history.read'],
      limits: { requestBytes: 16 * 1024, responseBytes: 384 * 1024, timeoutMs: 7000 },
    },
    {
      id: 'message.cancel',
      effect: controlServiceEffects['message.cancel'],
      // One uuid in, one enum out. Nothing about this grows with the conversation.
      limits: { requestBytes: 1024, responseBytes: 1024, timeoutMs: 7000 },
    },
    {
      id: 'transcript.read',
      effect: controlServiceEffects['transcript.read'],
      // A request is a target and four numbers; an answer is a bounded window of messages, and the
      // input schema caps it at two hundred at eight kilobytes of text — which is the ceiling this
      // budget has to hold, not a guess about typical size.
      limits: { requestBytes: 4 * 1024, responseBytes: 384 * 1024, timeoutMs: 7000 },
    },
    {
      id: 'context.compact',
      effect: controlServiceEffects['context.compact'],
      limits: { requestBytes: 8192, responseBytes: 8192, timeoutMs: 5000 },
    },
    {
      id: 'context.operation',
      effect: controlServiceEffects['context.operation'],
      limits: { requestBytes: 8192, responseBytes: 8192, timeoutMs: 5000 },
    },
    {
      id: 'session.fork',
      effect: controlServiceEffects['session.fork'],
      limits: { requestBytes: 8192, responseBytes: 16 * 1024, timeoutMs: 30_000 },
    },
    {
      id: 'turn.steer',
      effect: controlServiceEffects['turn.steer'],
      limits: { requestBytes: 32 * 1024, responseBytes: 8192, timeoutMs: 15_000 },
    },
    {
      id: 'turn.steering-operation',
      effect: controlServiceEffects['turn.steering-operation'],
      limits: { requestBytes: 8192, responseBytes: 8192, timeoutMs: 5000 },
    },
    {
      id: 'selection.read',
      effect: controlServiceEffects['selection.read'],
      limits: { requestBytes: 8192, responseBytes: 16 * 1024, timeoutMs: 5000 },
    },
    {
      id: 'selection.update',
      effect: controlServiceEffects['selection.update'],
      limits: { requestBytes: 16 * 1024, responseBytes: 16 * 1024, timeoutMs: 10_000 },
    },
    {
      id: 'permission.read',
      effect: controlServiceEffects['permission.read'],
      limits: { requestBytes: 8192, responseBytes: 16 * 1024, timeoutMs: 5000 },
    },
    {
      id: 'permission.update',
      effect: controlServiceEffects['permission.update'],
      limits: { requestBytes: 8192, responseBytes: 16 * 1024, timeoutMs: 15_000 },
    },
    {
      id: 'attachment.begin',
      effect: controlServiceEffects['attachment.begin'],
      limits: { requestBytes: 8192, responseBytes: 4096, timeoutMs: 10_000 },
    },
    {
      id: 'attachment.chunk',
      effect: controlServiceEffects['attachment.chunk'],
      limits: { requestBytes: 36 * 1024, responseBytes: 4096, timeoutMs: 10_000 },
    },
    {
      id: 'attachment.finalize',
      effect: controlServiceEffects['attachment.finalize'],
      limits: { requestBytes: 8192, responseBytes: 4096, timeoutMs: 15_000 },
    },
    {
      id: 'attachment.cancel',
      effect: controlServiceEffects['attachment.cancel'],
      limits: { requestBytes: 8192, responseBytes: 4096, timeoutMs: 10_000 },
    },
    {
      id: 'attachment.read',
      effect: controlServiceEffects['attachment.read'],
      limits: { requestBytes: 8192, responseBytes: 36 * 1024, timeoutMs: 5000 },
    },
    {
      id: 'runtime.list',
      effect: controlServiceEffects['runtime.list'],
      limits: { requestBytes: 4096, responseBytes: 16 * 1024, timeoutMs: 5000 },
    },
    {
      id: 'session.get',
      effect: controlServiceEffects['session.get'],
      limits: { requestBytes: 4096, responseBytes: 32 * 1024, timeoutMs: 5000 },
    },
    {
      id: 'session.create',
      effect: controlServiceEffects['session.create'],
      limits: { requestBytes: 64 * 1024, responseBytes: 16 * 1024, timeoutMs: 30_000 },
    },
    {
      id: 'session.archive',
      effect: controlServiceEffects['session.archive'],
      limits: { requestBytes: 4096, responseBytes: 16 * 1024, timeoutMs: 15_000 },
    },
    {
      id: 'message.send',
      effect: controlServiceEffects['message.send'],
      limits: { requestBytes: 32 * 1024, responseBytes: 8192, timeoutMs: 15_000 },
    },
    {
      id: 'session.start',
      effect: controlServiceEffects['session.start'],
      limits: { requestBytes: 4096, responseBytes: 8192, timeoutMs: 15_000 },
    },
    {
      id: 'turn.interrupt',
      effect: controlServiceEffects['turn.interrupt'],
      limits: { requestBytes: 8192, responseBytes: 8192, timeoutMs: 10_000 },
    },
    {
      id: 'native.read',
      effect: controlServiceEffects['native.read'],
      limits: { requestBytes: 8192, responseBytes: CONTROL_MAX_BYTES + 4096, timeoutMs: 5000 },
    },
    {
      id: 'native.respond',
      effect: controlServiceEffects['native.respond'],
      limits: { requestBytes: 64 * 1024, responseBytes: 8192, timeoutMs: 10_000 },
    },
    {
      id: 'session.wait',
      effect: controlServiceEffects['session.wait'],
      limits: { requestBytes: 8192, responseBytes: 64 * 1024, timeoutMs: 30_000 },
    },
    {
      id: 'model.list',
      effect: controlServiceEffects['model.list'],
      limits: { requestBytes: 4096, responseBytes: 256 * 1024, timeoutMs: 10_000 },
    },
    {
      id: 'directory.list',
      effect: controlServiceEffects['directory.list'],
      limits: { requestBytes: 16 * 1024, responseBytes: 256 * 1024, timeoutMs: 10_000 },
    },
  ],
});

export const ccmuxControlServiceComposition = {
  descriptor: ccmuxControlServiceDescriptor,
  baseUrl: CCMUX_CONTROL_SERVICE_BASE_URL,
  prefix: CCMUX_CONTROL_SERVICE_PREFIX,
};

export const ControlServiceInvocationSchema = z
  .object({
    v: z.literal(1),
    id: z.uuid(),
    caller: z.string().regex(RC_PREFIX_RE).max(128),
    service: z.literal(CCMUX_CONTROL_SERVICE_ID),
    revision: z.literal(CCMUX_CONTROL_SERVICE_REVISION),
    operation: ControlServiceOperationSchema,
    payload: z
      .string()
      .max(CCMUX_CONTROL_SERVICE_MAX_REQUEST_BYTES)
      .refine(
        (value) =>
          new TextEncoder().encode(value).byteLength <= CCMUX_CONTROL_SERVICE_MAX_REQUEST_BYTES,
        'payload exceeds byte budget',
      ),
  })
  .strict();
export type ControlServiceInvocation = z.output<typeof ControlServiceInvocationSchema>;

export function serviceOperation(operation: ControlServiceOperation) {
  const descriptor = ccmuxControlServiceDescriptor.operations.find(
    (entry) => entry.id === operation,
  );
  if (!descriptor) throw new Error(`Missing service descriptor for ${operation}`);
  return descriptor;
}

function controlServiceEffect(
  operation: ControlServiceOperation,
): z.output<typeof ControlServiceEffectSchema> {
  return controlServiceEffects[operation];
}
