import { AppError } from 'stitchkit';
import type { z } from 'zod';
import { ChatPrincipalSchema } from '../../chat/identitySchema.ts';
import { readRuntimeCatalog } from '../../runtime/catalog.ts';
import { clearLifecycleBlock } from '../../session/lifecycleBlocks.ts';
import { withSessionRegistryLock } from '../../session/registryLock.ts';
import { startSession } from '../../session/start.ts';
import type { ChatPrincipal } from '../../types.ts';
import {
  controlMcpServer,
  readControlCommands,
  readControlMcpServers,
  rewindControlFiles,
  runControlCommand,
  setControlPermissionMode,
} from '../command.ts';
import { settledCreateRequest } from '../createReceipts.ts';
import { readControlDirectory } from '../directories.ts';
import { archiveControlSession, createControlSession } from '../lifecycle.ts';
import { acceptControlMessage } from '../message.ts';
import { readControlModels } from '../models.ts';
import { interruptControlTurn, waitControlSession } from '../native.ts';
import { readControlNative, respondControlNative } from '../nativeFeed.ts';
import { readControlPermission, updateControlPermission } from '../permission.ts';
import type { ControlTargetSchema } from '../schema/core.ts';
import type { ControlDirectoryReadSchema } from '../schema/directory.ts';
import type { ControlInterruptSchema, ControlMessageSchema } from '../schema/message.ts';
import type { ControlModelsReadSchema } from '../schema/model.ts';
import type { ControlNativeReadSchema, ControlNativeResponseSchema } from '../schema/native.ts';
import type {
  ControlCommandsReadSchema,
  ControlMcpControlSchema,
  ControlMcpReadSchema,
  ControlPermissionModeSchema,
  ControlPermissionReadSchema,
  ControlPermissionUpdateSchema,
  ControlRewindSchema,
  ControlRunCommandSchema,
  ControlWaitSchema,
} from '../schema/runtimeOps.ts';
import type { ControlCreateSchema } from '../schema/session.ts';
import { controlTarget } from '../target.ts';
import type { OperationContext } from './context.ts';
import { controlRefusal } from './refusal.ts';

type TargetInput = z.output<typeof ControlTargetSchema>;
type CreateInput = z.output<typeof ControlCreateSchema>;
type MessageInput = z.output<typeof ControlMessageSchema>;
type InterruptInput = z.output<typeof ControlInterruptSchema>;
type NativeReadInput = z.output<typeof ControlNativeReadSchema>;
type NativeResponseInput = z.output<typeof ControlNativeResponseSchema>;
type ModelsReadInput = z.output<typeof ControlModelsReadSchema>;
type WaitInput = z.output<typeof ControlWaitSchema>;

/** Caller budget for one bounded provider model-catalog read. */
export const CONTROL_MODELS_CALL_BUDGET_MS = 5_000;

/** Managed sessions and their runtimes: inventory, lifecycle, native state, models, commands, permissions, MCP, rewind, responses and waiting. */
export function sessionOperations(context: OperationContext) {
  const { m, publisher, external, mutations, waits, reads, catalog, dependencies } = context;
  return {
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
      // A retry of a create that already completed is answered from its receipt, outside the
      // admission: it performs no work, and refusing it for concurrency told the caller "busy"
      // about a session that already exists.
      settledCreateRequest(m, input.requestId)
        ? (dependencies.createManagedSession === undefined
            ? createControlSession(m, input, signal ?? new AbortController().signal)
            : createControlSession(
                m,
                input,
                signal ?? new AbortController().signal,
                dependencies.createManagedSession,
              )
          ).catch(controlRefusal)
        : mutations
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
          ({ signal: admitted }) =>
            interruptControlTurn(m, input.target, input.generation, input.turnId, admitted),
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
        .run(
          undefined,
          ({ signal: admitted }) =>
            // Only the Codex host catalog costs a process start per read; a session's own catalog
            // and other runtimes' catalogs answer from something already running.
            input.target === undefined && (input.runtime ?? 'codex') === 'codex'
              ? catalog.get(input, admitted)
              : readControlModels(m, input, admitted),
          {
            ...(signal ? { signal } : {}),
            timeoutMs: CONTROL_MODELS_CALL_BUDGET_MS,
          },
        )
        .catch(controlRefusal),
    commands: (input: z.output<typeof ControlCommandsReadSchema>) =>
      readControlCommands(m, input.target),
    command: (input: z.output<typeof ControlRunCommandSchema>, signal?: AbortSignal) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => runControlCommand(m, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 10_000 },
        )
        .catch(controlRefusal),
    permissionRead: (input: z.output<typeof ControlPermissionReadSchema>) =>
      readControlPermission(m, input),
    permissionUpdate: (
      input: z.output<typeof ControlPermissionUpdateSchema>,
      signal?: AbortSignal,
    ) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => updateControlPermission(m, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 15_000 },
        )
        .catch(controlRefusal),
    permissionMode: (input: z.output<typeof ControlPermissionModeSchema>, signal?: AbortSignal) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => setControlPermissionMode(m, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 15_000 },
        )
        .catch(controlRefusal),
    mcpServers: (input: z.output<typeof ControlMcpReadSchema>) =>
      readControlMcpServers(m, input.target),
    mcpControl: (input: z.output<typeof ControlMcpControlSchema>, signal?: AbortSignal) =>
      mutations
        .run(input.target.session, ({ signal: admitted }) => controlMcpServer(m, input, admitted), {
          ...(signal ? { signal } : {}),
          timeoutMs: 30_000,
        })
        .catch(controlRefusal),
    rewind: (input: z.output<typeof ControlRewindSchema>, signal?: AbortSignal) =>
      mutations
        .run(
          input.target.session,
          ({ signal: admitted }) => rewindControlFiles(m, input, admitted),
          { ...(signal ? { signal } : {}), timeoutMs: 60_000 },
        )
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
}
