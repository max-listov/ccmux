import { z } from 'zod';
import { ApplicationPolicyEvidenceSchema } from '../policy/reference.ts';
import { RuntimeAppliedProfileSchema } from '../policy/runtimeProfile.ts';
import { PermissionScopeSchema } from './permissionScope.ts';
import { PlanLimitsSchema } from './planLimits.ts';
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
export type NativeUsage = z.infer<typeof NativeUsageSchema>;
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
    /**
     * What the runtime is asking permission for.
     *
     * `tool` exists because the two original values describe the two things one runtime happened to
     * ask about. A permission request for a network fetch, a subagent task or an MCP tool is neither
     * a command nor a file, and without a name for it such a request has nowhere to land — it would
     * arrive as a blocking question the projection cannot classify.
     */
    approvalKind: z.enum(['command', 'file', 'tool']).nullable(),
    turnId: z.string().min(1).max(256),
    itemId: z.string().min(1).max(256),
    reason: z.string().max(2_048).nullable(),
    scope: PermissionScopeSchema.nullable().default(null),
    decisions: z.array(z.enum(['accept', 'acceptForSession', 'decline', 'cancel'])).max(4),
    // Four, because that is what a runtime is allowed to ask. A cap of three made a legal
    // four-question request unrepresentable: the snapshot would fail to parse while the runtime sat
    // blocked on a callback nobody could answer, and the session would strand with no reason given.
    questions: z.array(NativeQuestionSchema).max(4),
    requestedAt: z.iso.datetime(),
  })
  .strict();
/**
 * How much a turn may do without asking. The set is the runtime's, not this project's invention.
 */
export const PermissionModeSchema = z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * How full the conversation's context window is, as the runtime measures it.
 *
 * `limitTokens` is the window a turn is actually judged against and `rawLimitTokens` is the model's
 * own; they differ when a compaction policy sets a smaller one, and a reader shown only a percentage
 * cannot tell which it was against. Both are carried so the number is interpretable.
 */
export const NativeContextUsageSchema = z
  .object({
    usedTokens: z.number().int().nonnegative(),
    limitTokens: z.number().int().positive(),
    rawLimitTokens: z.number().int().positive(),
    percent: z.number().min(0).max(100),
    window: z.enum(['model-limit', 'compaction-window']),
    observedAt: z.iso.datetime(),
  })
  .strict();
export type NativeContextUsage = z.infer<typeof NativeContextUsageSchema>;

/**
 * Which account a session runs on, and what it has spent on it.
 *
 * An identity, never a credential: no token, key, or the name of the place one came from reaches
 * this — knowing WHERE a credential lives is a step toward it and answers nothing about who is
 * spending. The label is what a person recognises the account by; a fleet of many sessions is read
 * by grouping on it, which is the whole reason it exists.
 */
export const NativeAccountSchema = z
  .object({
    label: z.string().min(1).max(256).nullable(),
    organization: z.string().max(256).nullable(),
    subscription: z.string().max(128).nullable(),
    provider: z.string().max(64).nullable(),
  })
  .strict();
export type NativeAccount = z.infer<typeof NativeAccountSchema>;

/** Cumulative spend the runtime reports for this conversation. Null when it reports none. */
export const NativeSpendSchema = z
  .object({ totalCostUsd: z.number().nonnegative().nullable(), observedAt: z.iso.datetime() })
  .strict();

/**
 * One MCP server of a session, as its runtime reports it.
 *
 * The server's own configuration is deliberately absent — a URL, a header or a token belongs to the
 * host that wrote it and has no business travelling in a status projection. `error` IS carried: it
 * is the runtime's own sentence about a server that failed, and without it a failed server is
 * undiagnosable, which is the whole reason a status exists.
 */
export const NativeMcpServerSchema = z
  .object({
    name: z.string().min(1).max(128),
    status: z.enum(['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'unknown']),
    scope: z.string().max(64).nullable(),
    /** How many tools it contributes. Null when it is not connected and therefore contributes none. */
    tools: z.number().int().nonnegative().nullable(),
    error: z.string().max(512).nullable(),
  })
  .strict();
export type NativeMcpServer = z.infer<typeof NativeMcpServerSchema>;

export const NativeSnapshotSchema = z
  .object({
    protocol: z.literal(1),
    provider: z.enum(['codex', 'opencode', 'custom', 'claude']),
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
    /**
     * The permission mode the next turn will run under, as the runtime reports it.
     *
     * Published rather than assumed: the mode is what decides whether a turn may write files, and a
     * reader that has to infer it from the launch configuration is reading the mode a session
     * STARTED in, not the one it is in. Absent on runtimes that do not report one.
     */
    permissionMode: PermissionModeSchema.optional(),
    /**
     * Absent until the runtime has been asked once — a session that has taken no turn has nothing
     * measured, and a zero would read as an empty window rather than as an unasked question.
     */
    contextUsage: NativeContextUsageSchema.optional(),
    /** Absent on runtimes that do not name an account, which is not the same as having none. */
    account: NativeAccountSchema.optional(),
    /**
     * How much of the plan the ACCOUNT has used, as the runtime reports it.
     *
     * Absent means this build never asked; the three answers a runtime can give — a filled window,
     * no plan limit at all, and does-not-publish — are inside the projection, because collapsing
     * any of them into absence tells an operator the plan is fine when it may be exhausted.
     */
    planLimits: PlanLimitsSchema.optional(),
    spend: NativeSpendSchema.optional(),
    /**
     * Whether this session is keeping file checkpoints. Published because a rewind is only possible
     * where they exist, and a caller told "no checkpoints" after the fact learns it too late.
     */
    fileCheckpoints: z.boolean().optional(),
    /** Absent on runtimes that do not report their MCP servers; empty means it reported none. */
    mcpServers: z.array(NativeMcpServerSchema).max(64).optional(),
  })
  .strict();
export type NativeSnapshot = z.infer<typeof NativeSnapshotSchema>;
export type NativeTurn = z.infer<typeof NativeTurnSchema>;
export type NativeItem = z.infer<typeof NativeItemSchema>;
export type NativePendingRequest = z.infer<typeof NativePendingRequestSchema>;
