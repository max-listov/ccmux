import { AppError } from 'stitchkit';
import {
  type ApplicationAdmission,
  BoundedAdmissionRefusalError,
  BoundedOperationWaitError,
  createBoundedAdmission,
} from 'stitchkit/application';
import type { z } from 'zod';
import type {
  AttachmentBeginSchema,
  AttachmentChunkSchema,
  AttachmentReadSchema,
  AttachmentUploadSelectorSchema,
} from '../attachments/schema.ts';
import {
  appendAttachmentChunk,
  beginAttachmentUpload,
  cancelAttachmentUpload,
  finalizeAttachmentUpload,
  readAttachmentChunk,
} from '../attachments/service.ts';
import type { CreateManagedInput } from '../commands/create.ts';
import { startSession } from '../commands/lifecycle.ts';
import { clearLifecycleBlock } from '../config/lifecycleBlocks.ts';
import { withSessionRegistryLock } from '../config/registryLock.ts';
import { ChatPrincipalSchema } from '../config/schema.ts';
import type { NativeForkRequestSchema } from '../context/schema.ts';
import type { ExternalStatusPublisher } from '../external/resident-publisher.ts';
import { readRuntimeCatalog } from '../runtime/catalog.ts';
import type { SteeringInputSchema, SteeringSelectorSchema } from '../steering/schema.ts';
import { readNativeSteering, steerNativeTurn } from '../steering/service.ts';
import type { ChatPrincipal, MachineConfig, Session } from '../types.ts';
import {
  compactControlContext,
  readControlContextOperation,
  readControlHistory,
} from './context.ts';
import type {
  ControlCompactSchema,
  ControlContextOperationReadSchema,
  ControlHistoryReadSchema,
} from './contextSchema.ts';
import { readControlDirectory } from './directories.ts';
import type { ControlDirectoryReadSchema } from './directorySchema.ts';
import { archiveControlSession, createControlSession, forkControlSession } from './lifecycle.ts';
import { acceptControlMessage } from './message.ts';
import { readControlModels } from './models.ts';
import { interruptControlTurn, waitControlSession } from './native.ts';
import { readControlNative, respondControlNative } from './nativeFeed.ts';
import type { ControlPublisher } from './publisher.ts';
import type {
  ControlCreateSchema,
  ControlInterruptSchema,
  ControlMessageSchema,
  ControlModelsReadSchema,
  ControlNativeReadSchema,
  ControlNativeResponseSchema,
  ControlTargetSchema,
  ControlWaitSchema,
} from './schema.ts';
import { readControlSelection, updateControlSelection } from './selection.ts';
import type { SelectionReadSchema, SelectionUpdateSchema } from './selectionSchema.ts';
import { controlTarget } from './target.ts';

type TargetInput = z.output<typeof ControlTargetSchema>;
type CreateInput = z.output<typeof ControlCreateSchema>;
type MessageInput = z.output<typeof ControlMessageSchema>;
type InterruptInput = z.output<typeof ControlInterruptSchema>;
type NativeReadInput = z.output<typeof ControlNativeReadSchema>;
type NativeResponseInput = z.output<typeof ControlNativeResponseSchema>;
type ModelsReadInput = z.output<typeof ControlModelsReadSchema>;
type WaitInput = z.output<typeof ControlWaitSchema>;

const detachedSignal = (): AbortSignal => new AbortController().signal;

/** Caller budget for one bounded provider model-catalog read. */
export const CONTROL_MODELS_CALL_BUDGET_MS = 5_000;

export type ControlOperationDependencies = {
  createManagedSession?: (machine: MachineConfig, input: CreateManagedInput) => Promise<Session>;
};

/**
 * One domain operation surface shared by local IPC and declared-service ingress.
 * Admission is created once here, so adding a transport cannot add capacity or a writer.
 */
export function createControlOperations(
  m: MachineConfig,
  publisher: ControlPublisher,
  external: ExternalStatusPublisher,
  upstream?: ApplicationAdmission,
  dependencies: ControlOperationDependencies = {},
) {
  const mutations = createBoundedAdmission({
    ...(upstream ? { upstream } : {}),
    policy: { global: { maxConcurrent: 8 }, perKey: { maxConcurrent: 1, maxKeys: 256 } },
  });
  const waits = createBoundedAdmission({
    ...(upstream ? { upstream } : {}),
    policy: { global: { maxConcurrent: 16 } },
  });
  const reads = createBoundedAdmission({
    ...(upstream ? { upstream } : {}),
    policy: { global: { maxConcurrent: 4 } },
  });
  const operations = {
    history: (input: z.output<typeof ControlHistoryReadSchema>, signal?: AbortSignal) =>
      reads
        .run(undefined, ({ signal: admitted }) => readControlHistory(m, input, admitted), {
          ...(signal ? { signal } : {}),
          timeoutMs: 6_000,
        })
        .catch(controlRefusal),
    compact: (input: z.output<typeof ControlCompactSchema>, signal?: AbortSignal) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => compactControlContext(m, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 5_000 },
        )
        .catch(controlRefusal),
    contextOperation: (input: z.output<typeof ControlContextOperationReadSchema>) =>
      readControlContextOperation(m, input),
    fork: (input: z.output<typeof NativeForkRequestSchema>, signal?: AbortSignal) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => forkControlSession(m, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 60_000 },
        )
        .catch(controlRefusal),
    steer: (
      input: z.output<typeof SteeringInputSchema>,
      principal: ChatPrincipal,
      signal?: AbortSignal,
    ) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => steerNativeTurn(m, principal, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 15_000 },
        )
        .catch(controlRefusal),
    steeringOperation: (
      input: z.output<typeof SteeringSelectorSchema>,
      principal: ChatPrincipal,
      signal?: AbortSignal,
    ) =>
      reads
        .run(
          undefined,
          ({ signal: admitted }) => readNativeSteering(m, principal, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 5_000 },
        )
        .catch(controlRefusal),
    selection: (input: z.output<typeof SelectionReadSchema>, signal?: AbortSignal) =>
      reads
        .run(undefined, ({ signal: admitted }) => readControlSelection(m, input, admitted), {
          ...(signal ? { signal } : {}),
          timeoutMs: 5_000,
        })
        .catch(controlRefusal),
    select: (input: z.output<typeof SelectionUpdateSchema>, signal?: AbortSignal) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => updateControlSelection(m, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 10_000 },
        )
        .catch(controlRefusal),
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
    runtimes: () => readRuntimeCatalog(m),
    list: () => publisher.read(),
    external: () => external.read(),
    get: (input: TargetInput) => {
      controlTarget(m, input.target);
      const row = publisher
        .read()
        .sessions.find(
          (session) =>
            session.identity.session === input.target.session &&
            session.identity.threadId === input.target.threadId,
        );
      if (!row) throw new AppError('UNAVAILABLE', 'Session has no prepared observation', 503);
      return row;
    },
    create: (input: CreateInput, signal?: AbortSignal) =>
      mutations
        .run(
          `create:${input.requestId}`,
          ({ signal: admitted }) =>
            dependencies.createManagedSession === undefined
              ? createControlSession(m, input, admitted)
              : createControlSession(m, input, admitted, dependencies.createManagedSession),
          { ...(signal ? { signal } : {}), timeoutMs: 60_000 },
        )
        .catch(controlRefusal),
    archive: (input: TargetInput, signal?: AbortSignal) =>
      mutations
        .run(
          input.target.session,
          () => {
            controlTarget(m, input.target);
            return archiveControlSession(m, input.target);
          },
          { ...(signal ? { signal } : {}), timeoutMs: 15_000 },
        )
        .catch(controlRefusal),
    message: (input: MessageInput, principal: ChatPrincipal, signal?: AbortSignal) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) =>
            acceptControlMessage(m, ChatPrincipalSchema.parse(principal), input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 15_000 },
        )
        .catch(controlRefusal),
    start: (input: TargetInput, signal?: AbortSignal) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) =>
            withSessionRegistryLock(m, async () => {
              admitted.throwIfAborted();
              const session = controlTarget(m, input.target);
              if (session.archived)
                throw new AppError('ARCHIVED', 'Archived sessions cannot be started', 409);
              clearLifecycleBlock(m, session.name);
              await startSession(m, session.name, session.dir);
              return { target: input.target, accepted: true as const };
            }),
          { ...(signal ? { signal } : {}), timeoutMs: 15_000 },
        )
        .catch(controlRefusal),
    interrupt: (input: InterruptInput, signal?: AbortSignal) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => interruptControlTurn(m, input.target, input.turnId, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 10_000 },
        )
        .catch(controlRefusal),
    native: (input: NativeReadInput) => readControlNative(m, input.target, input.cursor),
    directories: (input: z.output<typeof ControlDirectoryReadSchema>, signal?: AbortSignal) =>
      reads
        .run(undefined, ({ signal: admitted }) => readControlDirectory(input, admitted), {
          ...(signal ? { signal } : {}),
          timeoutMs: 5_000,
        })
        .catch(controlRefusal),
    models: (input: ModelsReadInput, signal?: AbortSignal) =>
      reads
        .run(undefined, ({ signal: admitted }) => readControlModels(m, input, admitted), {
          ...(signal ? { signal } : {}),
          timeoutMs: CONTROL_MODELS_CALL_BUDGET_MS,
        })
        .catch(controlRefusal),
    respond: (input: NativeResponseInput, signal?: AbortSignal) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => respondControlNative(m, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 10_000 },
        )
        .catch(controlRefusal),
    wait: (input: WaitInput, signal?: AbortSignal) =>
      waits
        .run(
          undefined,
          ({ signal: admitted }) =>
            waitControlSession(m, publisher, input.target, input.timeoutMs, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 61_000 },
        )
        .catch(controlRefusal),
  };
  return { operations, mutations, waits, reads };
}

export type ControlOperations = ReturnType<typeof createControlOperations>['operations'];

export function controlOperationSignal(signal?: AbortSignal): AbortSignal {
  return signal ?? detachedSignal();
}

function controlRefusal(error: unknown): never {
  if (error instanceof BoundedAdmissionRefusalError) {
    const draining = error.reason === 'not-accepting' || error.reason === 'upstream';
    throw new AppError(
      draining ? 'UNAVAILABLE' : 'BUSY',
      draining ? 'Control is draining' : 'Control capacity reached',
      draining ? 503 : 429,
    );
  }
  if (error instanceof BoundedOperationWaitError) {
    throw new AppError(
      error.reason === 'timed-out' ? 'TIMEOUT' : 'CANCELLED',
      'Control call did not finish within its caller budget',
      504,
    );
  }
  throw error;
}
