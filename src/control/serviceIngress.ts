import { AppError } from "stitchkit";
import { defineContract } from "stitchkit/contract";
import { implement } from "stitchkit/server";
import { ZodError } from "zod";
import { cliPrincipal } from "../chat/identity.ts";
import type { ControlOperations } from "./operations.ts";
import {
  CCMUX_CONTROL_SERVICE_MAX_REQUEST_BYTES,
  ControlServiceInvocationSchema,
  ControlServiceReplyEnvelopeSchema,
  controlServiceInputs,
  controlServiceOutputs,
  serviceOperation,
  type ControlServiceInvocation,
} from "./serviceDescriptor.ts";

export const controlServiceIngressContract = defineContract(
  { prefix: "ccmux-control", scope: "local" },
  {
    invoke: {
      method: "POST",
      path: "/v1/invoke",
      desc: "Invoke one declared CCMux control operation from a trusted service transport",
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
      return ControlServiceReplyEnvelopeSchema.parse({ v: 1, revision: "1", result });
    },
  });
}

/** Trusted outer operation selects the handler; decoded payload never contains a selector. */
export async function dispatchControlService(
  operations: ControlOperations,
  invocation: ControlServiceInvocation,
  signal?: AbortSignal,
): Promise<unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(invocation.payload);
  } catch {
    throw new AppError("INVALID_INPUT", "Service payload is not JSON", 400);
  }
  let result: unknown;
  try {
    switch (invocation.operation) {
      case "session.get":
        result = operations.get(controlServiceInputs["session.get"].parse(decoded));
        break;
      case "session.create":
        result = await operations.create(controlServiceInputs["session.create"].parse(decoded), signal);
        break;
      case "session.archive":
        result = await operations.archive(controlServiceInputs["session.archive"].parse(decoded), signal);
        break;
      case "message.send":
        result = await operations.message(
          controlServiceInputs["message.send"].parse(decoded),
          cliPrincipal(invocation.caller),
          signal,
        );
        break;
      case "session.start":
        result = await operations.start(controlServiceInputs["session.start"].parse(decoded), signal);
        break;
      case "turn.interrupt":
        result = await operations.interrupt(controlServiceInputs["turn.interrupt"].parse(decoded), signal);
        break;
      case "native.read":
        result = operations.native(controlServiceInputs["native.read"].parse(decoded));
        break;
      case "native.respond":
        result = await operations.respond(controlServiceInputs["native.respond"].parse(decoded), signal);
        break;
      case "session.wait":
        result = await operations.wait(controlServiceInputs["session.wait"].parse(decoded), signal);
        break;
      case "model.list":
        result = await operations.models(controlServiceInputs["model.list"].parse(decoded), signal);
        break;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ZodError)
      throw new AppError("INVALID_INPUT", "Service payload is invalid", 400);
    throw error;
  }
  const parsed = controlServiceOutputs[invocation.operation].safeParse(result);
  if (!parsed.success) throw new AppError("INVALID_RESULT", "Control operation returned an invalid result", 500);
  const encoded = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(encoded).byteLength > serviceOperation(invocation.operation).limits.responseBytes)
    throw new AppError("RESPONSE_TOO_LARGE", "Control operation exceeded its response budget", 500);
  return parsed.data;
}
