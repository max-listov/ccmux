import type { z } from 'zod';
import { ChatPrincipalSchema } from '../../chat/identitySchema.ts';
import type { MessageOperationReadSchema } from '../../chat/messageOperationSchema.ts';
import type { NativeForkRequestSchema } from '../../context/schema.ts';
import type { SteeringInputSchema, SteeringSelectorSchema } from '../../steering/schema.ts';
import { readNativeSteering, steerNativeTurn } from '../../steering/service.ts';
import type { ChatPrincipal } from '../../types.ts';
import {
  compactControlContext,
  readControlContextOperation,
  readControlHistory,
} from '../context.ts';
import { forkControlSession } from '../fork.ts';
import { cancelControlMessage } from '../messageCancel.ts';
import { readMessageOperation } from '../messageOperation.ts';
import type {
  ControlCompactSchema,
  ControlContextOperationReadSchema,
  ControlHistoryReadSchema,
} from '../schema/context.ts';
import type { ControlMessageCancelSchema } from '../schema/message.ts';
import type { ControlTranscriptReadSchema } from '../schema/native.ts';
import type { SelectionReadSchema, SelectionUpdateSchema } from '../schema/selection.ts';
import { readControlSelection, updateControlSelection } from '../selection.ts';
import { readControlTranscript } from '../transcript.ts';
import type { OperationContext } from './context.ts';
import { controlRefusal } from './refusal.ts';

/** One conversation's history and its controls: messages, transcript, context, fork, steering and model selection. */
export function conversationOperations(context: OperationContext) {
  const { m, mutations, reads } = context;
  return {
    messageCancel: (input: z.output<typeof ControlMessageCancelSchema>, principal: ChatPrincipal) =>
      cancelControlMessage(m, input, ChatPrincipalSchema.parse(principal)),
    messageOperation: (
      input: z.output<typeof MessageOperationReadSchema>,
      principal: ChatPrincipal,
    ) => readMessageOperation(m, ChatPrincipalSchema.parse(principal), input),
    transcript: (input: z.output<typeof ControlTranscriptReadSchema>, signal?: AbortSignal) =>
      reads
        .run(undefined, ({ signal: admitted }) => readControlTranscript(m, input, admitted), {
          ...(signal ? { signal } : {}),
          timeoutMs: 6_000,
        })
        .catch(controlRefusal),
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
  };
}
