/**
 * `@stitchmux/client`: the Stitchmux control contract, its schemas, the refusal catalog, the resident
 * status frames and `createInjectedControlClient`, which runs the contract over a transport the
 * caller supplies (a Stitchwire service caller, a browser's fetch, a test double). Loading it runs no
 * Node code, so a browser imports it as it is (`test/client-browser-entry.test.ts`). The client over
 * the local daemon's socket is `@stitchmux/client/socket`; monitoring snapshots are read from
 * `@stitchmux/client/monitoring`.
 */

export type { OperationEffect } from 'stitchkit/contract';
export {
  type ControlSnapshot,
  ControlSnapshotSchema,
  ControlTargetSchema,
} from './control/schema/core.ts';
export { controlEventsContract } from './control/schema/eventsContract.ts';
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
export * from './control/schema/public.ts';
export { ControlWaitResultSchema, currentControlSnapshot } from './control/schema/runtimeOps.ts';
export type { ControlArchiveReceipt } from './control/schema/session.ts';
export { createInjectedControlClient } from './control/transport/boundary.ts';
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
export {
  applyExternalStatusFrame,
  createExternalStatusEncoder,
  type ExternalStatusFrame,
  ExternalStatusFrameSchema,
  type ExternalStatusRenewal,
  ExternalStatusRenewalSchema,
} from './external/residentFrames.ts';
export {
  currentExternalStatus,
  type ExternalStatusRow,
  ExternalStatusRowSchema,
  type ExternalStatusSnapshot,
  ExternalStatusSnapshotSchema,
} from './external/residentSchema.ts';
export { VERSION as CONTROL_CLIENT_VERSION } from './util/version.ts';
