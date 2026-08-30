import { z } from 'zod';
import { ApplicationPolicyEvidenceSchema } from '../policy/reference.ts';
import { RuntimeAppliedProfileSchema } from '../policy/runtimeProfile.ts';
import { PermissionScopeSchema } from './permissionScope.ts';
import { NativeSelectionEvidenceSchema } from './selectionSchema.ts';

export const NATIVE_RUNTIME_TTL_MS = 5_000;
export const NATIVE_RUNTIME_MAX_BYTES = 128 * 1024;
export const NATIVE_RUNTIME_MAX_EVENTS = 128;
export const NATIVE_RUNTIME_MAX_NATIVE_ITEMS = 128;

export const NativeStateSchema = z.enum([
  'working',
  'idle',
  'waiting-approval',
  'waiting-input',
  'unknown',
]);
export const NativeTurnSchema = z
  .object({
    id: z.string().min(1).max(256),
    status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']),
    startedAt: z.iso.datetime().nullable(),
  })
  .strict();
export const NativeEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    at: z.iso.datetime(),
    kind: z.enum(['state', 'turn-start', 'turn-end', 'unavailable']),
    state: NativeStateSchema,
    turn: NativeTurnSchema.nullable(),
  })
  .strict();
export const NativeUsageSchema = z
  .object({
    totalTokens: z.number().int().nonnegative().nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    reasoningOutputTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const NativeItemSchema = z
  .object({
    sequence: z.number().int().positive(),
    at: z.iso.datetime(),
    kind: z.enum([
      'user',
      'assistant',
      'reasoning',
      'tool',
      'approval',
      'input',
      'usage',
      'terminal',
    ]),
    stage: z.enum(['started', 'completed', 'updated', 'requested', 'submitted', 'resolved']),
    nativeId: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256).nullable(),
    requestId: z.string().min(1).max(256).nullable(),
    status: z.string().max(64).nullable(),
    text: z.string().max(8_192).nullable(),
    tool: z.string().max(128).nullable(),
    usage: NativeUsageSchema.nullable(),
  })
  .strict();
const NativeQuestionSchema = z
  .object({
    id: z.string().min(1).max(256),
    header: z.string().max(256),
    question: z.string().max(2_048),
    isOther: z.boolean(),
    isSecret: z.boolean(),
    options: z
      .array(
        z
          .object({
            label: z.string().max(256),
            description: z.string().max(1_024),
          })
          .strict(),
      )
      .max(32)
      .nullable(),
    multiple: z.boolean().optional(),
  })
  .strict();
export const NativePendingRequestSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    rpcId: z.union([z.number(), z.string()]),
    kind: z.enum(['approval', 'input']),
    approvalKind: z.enum(['command', 'file']).nullable(),
    turnId: z.string().min(1).max(256),
    itemId: z.string().min(1).max(256),
    reason: z.string().max(2_048).nullable(),
    scope: PermissionScopeSchema.nullable().default(null),
    decisions: z.array(z.enum(['accept', 'acceptForSession', 'decline', 'cancel'])).max(4),
    questions: z.array(NativeQuestionSchema).max(3),
    requestedAt: z.iso.datetime(),
  })
  .strict();
export const NativeSnapshotSchema = z
  .object({
    protocol: z.literal(1),
    provider: z.enum(['codex', 'opencode', 'custom']),
    machine: z.string().min(1).max(128),
    session: z.string().min(1).max(256),
    threadId: z.uuid(),
    generation: z.uuid(),
    sequence: z.number().int().nonnegative(),
    pid: z.number().int().positive(),
    providerPid: z.number().int().positive(),
    version: z.string().max(64),
    connected: z.boolean(),
    state: NativeStateSchema,
    reason: z.string().max(256).nullable(),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    turn: NativeTurnSchema.nullable(),
    events: z.array(NativeEventSchema).max(NATIVE_RUNTIME_MAX_EVENTS),
    nativeSequence: z.number().int().nonnegative().default(0),
    nativeItems: z.array(NativeItemSchema).max(NATIVE_RUNTIME_MAX_NATIVE_ITEMS).default([]),
    pendingRequests: z.array(NativePendingRequestSchema).max(16).default([]),
    applicationPolicy: ApplicationPolicyEvidenceSchema.optional(),
    nativeProfile: RuntimeAppliedProfileSchema.optional(),
    nativeSelection: NativeSelectionEvidenceSchema.nullable().default(null),
  })
  .strict();
export type NativeSnapshot = z.infer<typeof NativeSnapshotSchema>;
export type NativeTurn = z.infer<typeof NativeTurnSchema>;
export type NativeItem = z.infer<typeof NativeItemSchema>;
export type NativePendingRequest = z.infer<typeof NativePendingRequestSchema>;
