import { AppError } from 'stitchkit';
import { defineContract } from 'stitchkit/contract';
import { implement } from 'stitchkit/server';
import { ZodError } from 'zod';
import { cliPrincipal } from '../chat/identity.ts';
import type { ControlOperations } from './operations.ts';
import {
  CCMUX_CONTROL_SERVICE_MAX_REQUEST_BYTES,
  CCMUX_CONTROL_SERVICE_REVISION,
  type ControlServiceInvocation,
  ControlServiceInvocationSchema,
  ControlServiceReplyEnvelopeSchema,
  controlServiceInputs,
  controlServiceOutputs,
  serviceOperation,
} from './serviceDescriptor.ts';

export const controlServiceIngressContract = defineContract(
  { prefix: 'ccmux-control', scope: 'local' },
  {
    invoke: {
      method: 'POST',
      path: '/invoke',
      desc: 'Invoke one declared CCMux control operation from a trusted service transport',
      input: ControlServiceInvocationSchema,
      output: ControlServiceReplyEnvelopeSchema,
      maxJsonBodyBytes: CCMUX_CONTROL_SERVICE_MAX_REQUEST_BYTES + 2048,
    },
  },
);

export function createControlServiceIngress(operations: ControlOperations) {
  return implement(controlServiceIngressContract, {
    invoke: async ({ input, signal }) => {
      const result = await dispatchControlService(operations, input, signal);
      return ControlServiceReplyEnvelopeSchema.parse({
        v: 1,
        revision: CCMUX_CONTROL_SERVICE_REVISION,
        result,
      });
    },
  });
}

/** Trusted outer operation selects the handler; decoded payload never contains a selector. */
export async function dispatchControlService(
  operations: ControlOperations,
  invocation: ControlServiceInvocation,
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    new TextEncoder().encode(invocation.payload).byteLength >
    serviceOperation(invocation.operation).limits.requestBytes
  )
    throw new AppError('REQUEST_TOO_LARGE', 'Service payload exceeds its operation budget', 400);
  let decoded: unknown;
  try {
    decoded = JSON.parse(invocation.payload);
  } catch {
    throw new AppError('INVALID_INPUT', 'Service payload is not JSON', 400);
  }
  let result: unknown;
  try {
    switch (invocation.operation) {
      case 'history.read':
        result = await operations.history(
          controlServiceInputs['history.read'].parse(decoded),
          signal,
        );
        break;
      case 'context.compact':
        result = await operations.compact(
          controlServiceInputs['context.compact'].parse(decoded),
          signal,
        );
        break;
      case 'context.operation':
        result = operations.contextOperation(
          controlServiceInputs['context.operation'].parse(decoded),
        );
        break;
      case 'session.fork':
        result = await operations.fork(controlServiceInputs['session.fork'].parse(decoded), signal);
        break;
      case 'turn.steer':
        result = await operations.steer(
          controlServiceInputs['turn.steer'].parse(decoded),
          cliPrincipal(invocation.caller),
          signal,
        );
        break;
      case 'turn.steering-operation':
        result = await operations.steeringOperation(
          controlServiceInputs['turn.steering-operation'].parse(decoded),
          cliPrincipal(invocation.caller),
          signal,
        );
        break;
      case 'selection.read':
        result = await operations.selection(
          controlServiceInputs['selection.read'].parse(decoded),
          signal,
        );
        break;
      case 'selection.update':
        result = await operations.select(
          controlServiceInputs['selection.update'].parse(decoded),
          signal,
        );
        break;
      case 'attachment.begin':
        result = await operations.attachmentBegin(
          controlServiceInputs['attachment.begin'].parse(decoded),
          cliPrincipal(invocation.caller),
          signal,
        );
        break;
      case 'attachment.chunk':
        result = await operations.attachmentChunk(
          controlServiceInputs['attachment.chunk'].parse(decoded),
          cliPrincipal(invocation.caller),
          signal,
        );
        break;
      case 'attachment.finalize':
        result = await operations.attachmentFinalize(
          controlServiceInputs['attachment.finalize'].parse(decoded),
          cliPrincipal(invocation.caller),
          signal,
        );
        break;
      case 'attachment.cancel':
        result = await operations.attachmentCancel(
          controlServiceInputs['attachment.cancel'].parse(decoded),
          cliPrincipal(invocation.caller),
          signal,
        );
        break;
      case 'attachment.read':
        result = await operations.attachmentRead(
          controlServiceInputs['attachment.read'].parse(decoded),
          cliPrincipal(invocation.caller),
          signal,
        );
        break;
      case 'runtime.list':
        controlServiceInputs['runtime.list'].parse(decoded);
        result = operations.runtimes();
        break;
      case 'directory.list':
        result = await operations.directories(
          controlServiceInputs['directory.list'].parse(decoded),
          signal,
        );
        break;
      case 'session.get':
        result = operations.get(controlServiceInputs['session.get'].parse(decoded));
        break;
      case 'session.create':
        result = await operations.create(
          controlServiceInputs['session.create'].parse(decoded),
          signal,
        );
        break;
      case 'session.archive':
        result = await operations.archive(
          controlServiceInputs['session.archive'].parse(decoded),
          signal,
        );
        break;
      case 'message.send':
        result = await operations.message(
          controlServiceInputs['message.send'].parse(decoded),
          cliPrincipal(invocation.caller),
          signal,
        );
        break;
      case 'session.start':
        result = await operations.start(
          controlServiceInputs['session.start'].parse(decoded),
          signal,
        );
        break;
      case 'turn.interrupt':
        result = await operations.interrupt(
          controlServiceInputs['turn.interrupt'].parse(decoded),
          signal,
        );
        break;
      case 'native.read':
        result = operations.native(controlServiceInputs['native.read'].parse(decoded));
        break;
      case 'native.respond':
        result = await operations.respond(
          controlServiceInputs['native.respond'].parse(decoded),
          signal,
        );
        break;
      case 'session.wait':
        result = await operations.wait(controlServiceInputs['session.wait'].parse(decoded), signal);
        break;
      case 'model.list':
        result = await operations.models(controlServiceInputs['model.list'].parse(decoded), signal);
        break;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ZodError)
      throw new AppError('INVALID_INPUT', 'Service payload is invalid', 400);
    throw error;
  }
  const parsed = controlServiceOutputs[invocation.operation].safeParse(result);
  if (!parsed.success)
    throw new AppError('INVALID_RESULT', 'Control operation returned an invalid result', 500);
  const encoded = JSON.stringify(parsed.data);
  if (
    new TextEncoder().encode(encoded).byteLength >
    serviceOperation(invocation.operation).limits.responseBytes
  )
    throw new AppError('RESPONSE_TOO_LARGE', 'Control operation exceeded its response budget', 500);
  return parsed.data;
}
