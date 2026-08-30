import { z } from "zod";
import { ManagedPeerSchema } from "../config/schema.ts";
import { AttachmentReferencesSchema } from "../attachments/reference.ts";

export const STEERING_LIMITS = { operations: 256, journalBytes: 256 * 1024, bodyBytes: 24 * 1024,
  requestBytes: 32 * 1024, deadlineMs: 15_000 };
export const SteeringSelectorSchema = z.object({ target: ManagedPeerSchema, registrationGeneration: z.uuid(),
  operationId: z.uuid() }).strict();
export const SteeringInputSchema = SteeringSelectorSchema.extend({ generation: z.uuid(),
  expectedTurnId: z.string().min(1).max(256), body: z.string().max(STEERING_LIMITS.bodyBytes).default(""),
  images: AttachmentReferencesSchema.default([]) }).strict().refine(value => value.body.trim().length > 0 || value.images.length > 0,
  "Steering requires text or an image").refine(value => new TextEncoder().encode(value.body).length <= STEERING_LIMITS.bodyBytes,
  "Steering text exceeds its byte limit");
export const SteeringReceiptSchema = z.object({ protocol: z.literal(1), operationId: z.uuid(), target: ManagedPeerSchema,
  registrationGeneration: z.uuid(), generation: z.uuid(), turnId: z.string().min(1).max(256),
  clientUserMessageId: z.string().max(64), state: z.enum(["submitted", "uncertain"]), observedAt: z.iso.datetime() }).strict()
  .refine(value => value.clientUserMessageId === `steer:${value.operationId}`, "Native steering identity must match the operation");
export const SteeringReadResultSchema = z.object({ operation: SteeringReceiptSchema.nullable() }).strict();
export type SteeringInput = z.output<typeof SteeringInputSchema>;
export type SteeringSelector = z.output<typeof SteeringSelectorSchema>;
export type SteeringReceipt = z.output<typeof SteeringReceiptSchema>;

export const SteeringOperationSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  principal: z.string().min(1).max(1024), phase: z.enum(["intent", "submitted", "uncertain"]),
  receipt: SteeringReceiptSchema, reason: z.string().max(128).nullable() }).strict();
export const SteeringJournalSchema = z.object({ registration: z.uuid(), threadId: z.uuid(),
  operations: z.array(SteeringOperationSchema).max(STEERING_LIMITS.operations) }).strict();
export type SteeringOperation = z.output<typeof SteeringOperationSchema>;
export type SteeringJournal = z.output<typeof SteeringJournalSchema>;
