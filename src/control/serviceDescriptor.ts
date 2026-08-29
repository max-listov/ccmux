import { ApiError, createClient, type ClientFetch } from "stitchkit";
import { defineContract } from "stitchkit/contract";
import { z } from "zod";
import { RC_PREFIX_RE } from "../config/schema.ts";
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
} from "./schema.ts";

export const CCMUX_CONTROL_SERVICE_ID = "ccmux.control";
export const CCMUX_CONTROL_SERVICE_REVISION = "1";
export const CCMUX_CONTROL_SERVICE_BASE_URL = "https://ccmux.invalid";
export const CCMUX_CONTROL_SERVICE_PREFIX = "/ccmux/control/1";
export const CCMUX_CONTROL_SERVICE_INGRESS_PATH = "/ccmux-control/v1/invoke";
export const CCMUX_CONTROL_SERVICE_MAX_REQUEST_BYTES = 64 * 1024;
export const CCMUX_CONTROL_SERVICE_MAX_RESPONSE_BYTES = CONTROL_MAX_BYTES + 4096;

export const ControlServiceOperationSchema = z.enum([
  "session.get",
  "session.create",
  "session.archive",
  "message.send",
  "session.start",
  "turn.interrupt",
  "native.read",
  "native.respond",
  "session.wait",
  "model.list",
]);
export type ControlServiceOperation = z.infer<typeof ControlServiceOperationSchema>;

export const ControlServiceEffectSchema = z.enum([
  "session.read",
  "session.create",
  "session.archive",
  "message.send",
  "session.start",
  "turn.interrupt",
  "native.read",
  "native.respond",
  "session.wait",
  "model.read",
]).refine((effect) => /^[a-z0-9][a-z0-9._-]*$/.test(effect), "invalid service effect identifier");
export type ControlServiceEffect = z.infer<typeof ControlServiceEffectSchema>;

export const controlServiceEffects = {
  "session.get": "session.read",
  "session.create": "session.create",
  "session.archive": "session.archive",
  "message.send": "message.send",
  "session.start": "session.start",
  "turn.interrupt": "turn.interrupt",
  "native.read": "native.read",
  "native.respond": "native.respond",
  "session.wait": "session.wait",
  "model.list": "model.read",
} satisfies Record<ControlServiceOperation, ControlServiceEffect>;

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
        ctx.addIssue({ code: "custom", path: ["operations"], message: `duplicate operation ${operation.id}` });
      seen.add(operation.id);
      if (operation.effect !== controlServiceEffect(operation.id))
        ctx.addIssue({ code: "custom", path: ["operations"], message: `wrong effect for ${operation.id}` });
    }
  });

export const ccmuxControlServiceDescriptor = ControlServiceDescriptorSchema.parse({
  service: CCMUX_CONTROL_SERVICE_ID,
  revision: CCMUX_CONTROL_SERVICE_REVISION,
  maxInflight: 8,
  operations: [
    { id: "session.get", effect: controlServiceEffects["session.get"], limits: { requestBytes: 4096, responseBytes: 32 * 1024, timeoutMs: 5000 } },
    { id: "session.create", effect: controlServiceEffects["session.create"], limits: { requestBytes: 64 * 1024, responseBytes: 16 * 1024, timeoutMs: 30_000 } },
    { id: "session.archive", effect: controlServiceEffects["session.archive"], limits: { requestBytes: 4096, responseBytes: 16 * 1024, timeoutMs: 15_000 } },
    { id: "message.send", effect: controlServiceEffects["message.send"], limits: { requestBytes: 32 * 1024, responseBytes: 8192, timeoutMs: 15_000 } },
    { id: "session.start", effect: controlServiceEffects["session.start"], limits: { requestBytes: 4096, responseBytes: 8192, timeoutMs: 15_000 } },
    { id: "turn.interrupt", effect: controlServiceEffects["turn.interrupt"], limits: { requestBytes: 8192, responseBytes: 8192, timeoutMs: 10_000 } },
    { id: "native.read", effect: controlServiceEffects["native.read"], limits: { requestBytes: 8192, responseBytes: CONTROL_MAX_BYTES + 4096, timeoutMs: 5000 } },
    { id: "native.respond", effect: controlServiceEffects["native.respond"], limits: { requestBytes: 64 * 1024, responseBytes: 8192, timeoutMs: 10_000 } },
    { id: "session.wait", effect: controlServiceEffects["session.wait"], limits: { requestBytes: 8192, responseBytes: 64 * 1024, timeoutMs: 30_000 } },
    { id: "model.list", effect: controlServiceEffects["model.list"], limits: { requestBytes: 4096, responseBytes: 256 * 1024, timeoutMs: 10_000 } },
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
        (value) => new TextEncoder().encode(value).byteLength <= CCMUX_CONTROL_SERVICE_MAX_REQUEST_BYTES,
        "payload exceeds byte budget",
      ),
  })
  .strict();
export type ControlServiceInvocation = z.output<typeof ControlServiceInvocationSchema>;

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
  "session.get": ControlTargetSchema,
  "session.create": ControlCreateSchema,
  "session.archive": ControlTargetSchema,
  "message.send": ControlMessageSchema,
  "session.start": ControlTargetSchema,
  "turn.interrupt": ControlInterruptSchema,
  "native.read": ControlNativeReadSchema,
  "native.respond": ControlNativeResponseSchema,
  "session.wait": ControlServiceWaitSchema,
  "model.list": ControlModelsReadSchema,
};

export const controlServiceOutputs = {
  "session.get": ControlRowSchema,
  "session.create": ControlCreateReceiptSchema,
  "session.archive": ControlArchiveReceiptSchema,
  "message.send": ControlMessageReceiptSchema,
  "session.start": ControlActionReceiptSchema,
  "turn.interrupt": ControlActionReceiptSchema,
  "native.read": ControlNativeSnapshotSchema,
  "native.respond": ControlNativeResponseReceiptSchema,
  "session.wait": ControlWaitResultSchema,
  "model.list": ControlModelCatalogSchema,
};

function serviceReply<T>(result: z.ZodType<T>) {
  return ControlServiceReplyEnvelopeSchema.transform((envelope, ctx): T => {
    const parsed = result.safeParse(envelope.result);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: "owner service returned an invalid result" });
      return z.NEVER;
    }
    return parsed.data;
  });
}

export const ccmuxControlServiceContract = defineContract(
  { prefix: CCMUX_CONTROL_SERVICE_PREFIX },
  {
    get: { method: "POST", path: "/session.get", desc: "Read one exact managed session", input: ControlTargetSchema, output: serviceReply(ControlRowSchema), idempotent: true, meta: { effect: controlServiceEffects["session.get"] } },
    create: { method: "POST", path: "/session.create", desc: "Idempotently create one managed Codex session", input: ControlCreateSchema, output: serviceReply(ControlCreateReceiptSchema), idempotent: true, timeout: 30_000, meta: { effect: controlServiceEffects["session.create"] } },
    archive: { method: "POST", path: "/session.archive", desc: "Archive one exact managed identity", input: ControlTargetSchema, output: serviceReply(ControlArchiveReceiptSchema), idempotent: true, meta: { effect: controlServiceEffects["session.archive"] } },
    message: { method: "POST", path: "/message.send", desc: "Accept one identity-pinned durable message", input: ControlMessageSchema, output: serviceReply(ControlMessageReceiptSchema), idempotent: true, meta: { effect: controlServiceEffects["message.send"] } },
    start: { method: "POST", path: "/session.start", desc: "Start one existing managed identity", input: ControlTargetSchema, output: serviceReply(ControlActionReceiptSchema), meta: { effect: controlServiceEffects["session.start"] } },
    interrupt: { method: "POST", path: "/turn.interrupt", desc: "Interrupt one exact active native turn", input: ControlInterruptSchema, output: serviceReply(ControlActionReceiptSchema), meta: { effect: controlServiceEffects["turn.interrupt"] } },
    native: { method: "POST", path: "/native.read", desc: "Read bounded native items after a cursor", input: ControlNativeReadSchema, output: serviceReply(ControlNativeSnapshotSchema), idempotent: true, meta: { effect: controlServiceEffects["native.read"] } },
    respond: { method: "POST", path: "/native.respond", desc: "Answer one exact current native request", input: ControlNativeResponseSchema, output: serviceReply(ControlNativeResponseReceiptSchema), idempotent: true, meta: { effect: controlServiceEffects["native.respond"] } },
    wait: { method: "POST", path: "/session.wait", desc: "Wait for a managed native session between turns", input: ControlServiceWaitSchema, output: serviceReply(ControlWaitResultSchema), idempotent: true, timeout: 30_000, meta: { effect: controlServiceEffects["session.wait"] } },
    models: { method: "POST", path: "/model.list", desc: "Read the connected App Server model catalog after an optional cursor", input: ControlModelsReadSchema, output: serviceReply(ControlModelCatalogSchema), idempotent: true, timeout: 10_000, meta: { effect: controlServiceEffects["model.list"] } },
  },
);

/** The composing transport supplies delivery. No socket, credential or retry is implicit. */
export function createCcmuxControlServiceClient(fetch: ClientFetch, timeoutMs = 30_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
    throw new Error("Invalid client deadline");
  return createClient(ccmuxControlServiceContract, {
    baseUrl: CCMUX_CONTROL_SERVICE_BASE_URL,
    timeout: timeoutMs,
    fetch: async (url, init) => {
      const route = new URL(String(url));
      if (
        route.origin !== CCMUX_CONTROL_SERVICE_BASE_URL ||
        !route.pathname.startsWith(`${CCMUX_CONTROL_SERVICE_PREFIX}/`) ||
        route.search !== "" ||
        init?.method !== "POST"
      )
        throw new ApiError("INVALID_OPERATION");
      const operation = ControlServiceOperationSchema.parse(
        route.pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
      );
      const body = typeof init.body === "string" ? init.body : "{}";
      const limit = serviceOperation(operation).limits.requestBytes;
      if (new TextEncoder().encode(body).byteLength > limit)
        throw new ApiError("REQUEST_TOO_LARGE");
      let decoded: unknown;
      try {
        decoded = JSON.parse(body);
      } catch {
        throw new ApiError("INVALID_INPUT");
      }
      const parsed = controlServiceInputs[operation].safeParse(decoded);
      if (!parsed.success) throw new ApiError("INVALID_INPUT");
      return fetch(url, { ...init, body: JSON.stringify(parsed.data) });
    },
  });
}

export function serviceOperation(operation: ControlServiceOperation) {
  const descriptor = ccmuxControlServiceDescriptor.operations.find((entry) => entry.id === operation);
  if (!descriptor) throw new Error(`Missing service descriptor for ${operation}`);
  return descriptor;
}

function controlServiceEffect(operation: ControlServiceOperation): z.output<typeof ControlServiceEffectSchema> {
  return controlServiceEffects[operation];
}

export type { ClientFetch } from "stitchkit";
export { ApiError } from "stitchkit";
