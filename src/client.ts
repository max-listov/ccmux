/**
 * `@stitchmux/client`: the one Stitchmux client. Typed control operations over either transport —
 * `createControlClient` connects to the local daemon's socket, `createInjectedControlClient` runs the
 * same contract over a transport the caller supplies (a Stitchwire service caller, a test double) —
 * with the schemas, the refusal catalog and the resident status frames both share. Monitoring
 * snapshots are read from `@stitchmux/client/monitoring`.
 */

export type { OperationEffect } from 'stitchkit/contract';
export { ControlTargetSchema } from './control/schema/core.ts';
export {
  ControlActionReceiptSchema,
  ControlInterruptSchema,
  ControlKeysSchema,
  type ControlMessage,
  ControlMessageReceiptSchema,
  ControlMessageSchema,
  ControlStopReceiptSchema,
} from './control/schema/message.ts';
export {
  ControlNativeStreamCursorSchema,
  ControlNativeStreamFrameSchema,
  type ControlNativeStreamRequest,
  ControlNativeStreamRequestSchema,
  controlNativeStreamFrame,
  createStitchmuxNativeStreamProfile,
  encodeControlNativeStreamCursor,
  readControlNativeStreamCursor,
  STITCHMUX_NATIVE_STREAM_COMMAND,
  STITCHMUX_NATIVE_STREAM_HEARTBEAT_MS,
  STITCHMUX_NATIVE_STREAM_MAX_FRAME_BYTES,
  STITCHMUX_NATIVE_STREAM_MAX_INPUT_BYTES,
  STITCHMUX_NATIVE_STREAM_PROFILE,
  StitchmuxNativeStreamProfileSchema,
} from './control/schema/nativeStreamContract.ts';
export { ControlWaitResultSchema } from './control/schema/runtimeOps.ts';
export { createInjectedControlClient } from './control/transport/boundary.ts';
export * from './control-client.ts';
export {
  EXTERNAL_CONTENT_LIMITS,
  ExternalContentCapabilitiesSchema,
  type ExternalContentRead,
  ExternalContentReadSchema,
  type ExternalContentResult,
  ExternalContentResultSchema,
  ExternalContentSelectorSchema,
  type ExternalContentTarget,
  ExternalContentTargetSchema,
} from './external/contentSchema.ts';
export {
  type ExternalMessageAuthorship,
  ExternalMessageAuthorshipSchema,
  type ExternalMessageRead,
  ExternalMessageReadSchema,
  type ExternalMessageResult,
  ExternalMessageResultSchema,
  ExternalMessageSchema,
} from './external/messageSchema.ts';
