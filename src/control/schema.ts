import { z } from 'zod';
import { ControlCommandSchema } from '../agent/claude/native/commandSchema.ts';
import { AttachmentReferencesSchema } from '../attachments/reference.ts';
import {
  MessageAttributionSchema,
  MessageOriginSchema,
  NotificationAudienceSchema,
} from '../chat/originSchema.ts';
import {
  AgentKindSchema,
  LaunchRecipeMetadataSchema,
  LaunchRecipeReferenceSchema,
  ManagedPeerSchema,
  ModelSelectionSchema,
  NativeSessionSchema,
  SESSION_NAME_RE,
} from '../config/schema.ts';
import { ContentCursorSchema, ContentReadSchema } from '../content/schema.ts';
import {
  ApplicationPolicyEvidenceSchema,
  ApplicationPolicyReferenceSchema,
} from '../policy/reference.ts';
import { RuntimeAppliedProfileSchema } from '../policy/runtimeProfile.ts';
import { RuntimeCapabilitiesSchema } from '../runtime/capabilities.ts';
import {
  NativeMcpServerSchema,
  NativePendingRequestSchema,
  NativeTurnSchema,
  PermissionModeSchema,
} from '../runtime/projectionSchema.ts';
import { RewindResultSchema } from '../runtime/rewindSchema.ts';
import {
  AcceptedTurnOptionsSchema,
  NativeSelectionEvidenceSchema,
  NativeTurnOptionsSchema,
} from '../runtime/selectionSchema.ts';

export const CONTROL_MAX_BYTES = 512 * 1024;
export const CONTROL_MAX_READERS = 32;
export const ControlTargetSchema = z.object({ target: ManagedPeerSchema }).strict();
export const ControlRowSchema = z
  .object({
    identity: ManagedPeerSchema,
    runtime: z.enum(['cli', 'app-server', 'native']),
    nativeSession: NativeSessionSchema.optional(),
    driverCapabilities: RuntimeCapabilitiesSchema.optional(),
    state: z.enum([
      'working',
      'idle',
      'waiting-approval',
      'waiting-input',
      'prompt',
      'stopped',
      'blocked',
      'unknown',
    ]),
    availability: z.enum(['live', 'stale', 'unavailable']),
    reason: z.string().max(512).nullable(),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    turn: NativeTurnSchema.nullable(),
    model: z.string().max(512).nullable(),
    launchRecipe: LaunchRecipeMetadataSchema.optional(),
    selection: AcceptedTurnOptionsSchema.nullable(),
    nativeSelection: NativeSelectionEvidenceSchema.nullable(),
    applicationPolicy: ApplicationPolicyEvidenceSchema.optional(),
    nativeProfile: RuntimeAppliedProfileSchema.optional(),
    capabilities: z
      .object({
        message: z.boolean(),
        start: z.boolean(),
        interrupt: z.boolean(),
        wait: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ControlRow = z.infer<typeof ControlRowSchema>;
export const ControlSnapshotSchema = z
  .object({
    protocol: z.literal(1),
    version: z.string().max(64),
    machine: z.string().max(128),
    generation: z.uuid(),
    sequence: z.number().int().nonnegative(),
    status: z.enum(['live', 'stale', 'unavailable']),
    reason: z.string().max(512).nullable(),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    omitted: z.number().int().nonnegative(),
    sessions: z.array(ControlRowSchema).max(256),
  })
  .strict();
export type ControlSnapshot = z.infer<typeof ControlSnapshotSchema>;
export const ControlMessageSchema = ControlTargetSchema.extend({
  messageId: z.uuid(),
  origin: MessageAttributionSchema.optional(),
  notification: NotificationAudienceSchema.optional(),
  registrationGeneration: z.uuid().optional(),
  body: z.string().trim().max(16_384).default(''),
  images: AttachmentReferencesSchema.default([]),
  options: NativeTurnOptionsSchema.optional(),
  defer: z.boolean().default(false),
  notBefore: z.iso.datetime().nullable().default(null),
  task: z.string().max(256).nullable().default(null),
})
  .strict()
  .refine(
    (value) => value.origin === undefined || value.registrationGeneration !== undefined,
    'Attributed input requires registration generation',
  )
  .refine((value) => value.body.length > 0 || value.images.length > 0, 'Message input is empty');
export type ControlMessage = z.input<typeof ControlMessageSchema>;
export const ControlMessageReceiptSchema = z
  .object({
    messageId: z.uuid(),
    origin: MessageOriginSchema,
    notification: NotificationAudienceSchema,
    registrationGeneration: z.uuid().nullable(),
    accepted: z.literal(true),
    duplicate: z.boolean(),
    turnOptions: AcceptedTurnOptionsSchema.nullable(),
  })
  .strict();
export const ControlInterruptSchema = ControlTargetSchema.extend({
  generation: z.uuid(),
  turnId: z.string().min(1).max(256),
}).strict();
export const ControlActionReceiptSchema = z
  .object({ target: ManagedPeerSchema, accepted: z.literal(true) })
  .strict();
export const ControlCreateSchema = z
  .object({
    runtime: AgentKindSchema.optional(),
    /**
     * Which execution mode of that agent, where it has more than one.
     *
     * Omitted keeps each agent's established mode, so every existing caller is unchanged. It exists
     * because the field above names an agent family, and for Claude that no longer selects a single
     * way to run: without this, the native mode is unreachable through the control plane entirely.
     */
    mode: z.enum(['tui', 'native']).optional(),
    requestId: z.uuid(),
    name: z.string().min(1).max(256).regex(SESSION_NAME_RE),
    workspace: z.string().startsWith('/').max(4_096),
    flags: z.array(z.string().max(4_096)).max(32).default([]),
    launchRecipe: LaunchRecipeReferenceSchema.optional(),
    modelSelection: ModelSelectionSchema.optional(),
    applicationPolicy: ApplicationPolicyReferenceSchema.optional(),
  })
  .strict();
export type ControlCreate = z.input<typeof ControlCreateSchema>;
export const ControlCreateReceiptSchema = z
  .object({
    requestId: z.uuid(),
    target: ManagedPeerSchema,
    workspace: z.string().startsWith('/').max(4_096),
    registrationGeneration: z.uuid(),
    duplicate: z.boolean(),
    launchRecipe: LaunchRecipeMetadataSchema.optional(),
    modelSelection: ModelSelectionSchema.optional(),
    applicationPolicy: ApplicationPolicyEvidenceSchema.optional(),
    nativeSession: NativeSessionSchema.optional(),
    driverCapabilities: RuntimeCapabilitiesSchema.optional(),
  })
  .strict();
export type ControlCreateReceipt = z.infer<typeof ControlCreateReceiptSchema>;
export const ControlArchiveReceiptSchema = z
  .object({
    target: ManagedPeerSchema,
    archived: z.literal(true),
    duplicate: z.boolean(),
    stopped: z.boolean(),
  })
  .strict();
export type ControlArchiveReceipt = z.infer<typeof ControlArchiveReceiptSchema>;
export const ControlNativeCursorSchema = ContentCursorSchema;
export const ControlNativeReadSchema = ControlTargetSchema.extend({
  cursor: ControlNativeCursorSchema.nullable().default(null),
}).strict();
export const ControlNativeSnapshotSchema = ContentReadSchema.extend({
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  pending: z.array(NativePendingRequestSchema.omit({ rpcId: true })).max(16),
  launchRecipe: LaunchRecipeMetadataSchema.optional(),
  selection: AcceptedTurnOptionsSchema.nullable(),
  nativeSelection: NativeSelectionEvidenceSchema.nullable(),
  applicationPolicy: ApplicationPolicyEvidenceSchema.optional(),
  nativeSession: NativeSessionSchema.optional(),
  nativeProfile: RuntimeAppliedProfileSchema.optional(),
  driverCapabilities: RuntimeCapabilitiesSchema.optional(),
}).strict();
export type ControlNativeSnapshot = z.infer<typeof ControlNativeSnapshotSchema>;
export const ControlNativeResponseSchema = ControlTargetSchema.extend({
  operationId: z.uuid(),
  generation: z.uuid(),
  requestId: z.string().min(1).max(256),
  kind: z.enum(['approval', 'input']),
  decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']).nullable().default(null),
  answers: z
    .record(z.string().min(1).max(256), z.array(z.string().max(4_096)).min(1).max(32))
    .nullable()
    .default(null),
}).strict();
export type ControlNativeResponse = z.input<typeof ControlNativeResponseSchema>;
export const ControlNativeResponseReceiptSchema = z
  .object({
    operationId: z.uuid(),
    requestId: z.string(),
    outcome: z.enum(['submitted', 'uncertain']),
  })
  .strict();
export type ControlNativeResponseReceipt = z.infer<typeof ControlNativeResponseReceiptSchema>;
export const CONTROL_MODELS_MAX_PAGE = 64;
export const ControlModelsReadSchema = z
  .object({
    runtime: AgentKindSchema.optional(),
    target: ManagedPeerSchema.optional(),
    launchRecipe: LaunchRecipeReferenceSchema.optional(),
    cursor: z.string().min(1).max(4_096).nullable().default(null),
    limit: z.number().int().min(1).max(CONTROL_MODELS_MAX_PAGE).default(CONTROL_MODELS_MAX_PAGE),
    includeHidden: z.boolean().default(false),
  })
  .strict()
  .refine(
    (input) => input.target === undefined || input.launchRecipe === undefined,
    'Choose a host recipe or an exact managed runtime, not both',
  );
export type ControlModelsRead = z.input<typeof ControlModelsReadSchema>;
export const ControlModelSchema = z
  .object({
    provider: z.string().min(1).max(128).optional(),
    id: z.string().min(1).max(256),
    model: z.string().min(1).max(256).optional(),
    displayName: z.string().min(1).max(256),
    description: z.string().max(2_048),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    inputModalities: z.array(z.string().min(1).max(64)).max(16),
    serviceTiers: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(256),
            description: z.string().max(1_024),
          })
          .strict(),
      )
      .max(16),
    supportedReasoningEfforts: z
      .array(
        z
          .object({
            reasoningEffort: z.string().min(1).max(64),
            description: z.string().max(1_024),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    defaultReasoningEffort: z.string().min(1).max(64).optional(),
    variants: z.array(z.string().min(1).max(128)).max(64).optional(),
  })
  .strict();
export type ControlModel = z.infer<typeof ControlModelSchema>;
export const ControlModelCatalogSchema = z
  .object({
    target: ManagedPeerSchema.optional(),
    source: z
      .object({
        kind: z.enum(['host', 'session']),
        machine: z.string().min(1),
        provider: z.string().min(1).max(128).nullable(),
        /** Which server backs `provider`, when the host declared one. Reported, never matched on. */
        providerLabel: z.string().max(64).nullable().default(null),
        runtime: AgentKindSchema,
        launchRecipe: LaunchRecipeMetadataSchema.optional(),
        /**
         * When this list was observed, for a runtime whose catalog only a running session can ask.
         *
         * Null where the answer is computed on the spot and the question does not arise. Where it
         * is not null it is load-bearing: a list left behind by a session that has since stopped is
         * still the best answer this host has, and calling it current would be the lie.
         */
        observedAt: z.string().max(64).nullable().default(null),
        /**
         * Whether the session that published this list is still running.
         *
         * `stale` is not a failure — it is "nobody is holding this runtime right now, and this is
         * what it last said". A caller choosing a model before creating a session wants exactly
         * that, and wants to know which of the two it got.
         */
        freshness: z.enum(['live', 'stale']).nullable().default(null),
      })
      .strict(),
    data: z.array(ControlModelSchema).max(CONTROL_MODELS_MAX_PAGE),
    agents: z.array(z.string().min(1).max(128)).max(128).optional(),
    nextCursor: z.string().max(4_096).nullable(),
  })
  .strict()
  .refine(
    (catalog) =>
      catalog.source.kind === 'host'
        ? catalog.target === undefined
        : catalog.target !== undefined &&
          catalog.target.agent === catalog.source.runtime &&
          catalog.target.machine === catalog.source.machine,
    'Catalog source must match its exact managed identity',
  );
export type ControlModelCatalog = z.infer<typeof ControlModelCatalogSchema>;
export const ControlCommandsReadSchema = ControlTargetSchema.strict();
export const ControlCommandCatalogSchema = z
  .object({
    target: ManagedPeerSchema,
    /** What the runtime named, verbatim: this project does not add commands of its own. */
    data: z.array(ControlCommandSchema).max(512),
  })
  .strict();
export const ControlRunCommandSchema = ControlTargetSchema.extend({
  /** The command's name, with or without its leading slash; an alias the runtime declared resolves. */
  command: z.string().min(1).max(128),
  /** Everything after the command, exactly as a person would have typed it. */
  args: z.string().max(4_096).optional(),
  /**
   * Idempotency, the same way a message carries it: a retried run must not become a second turn.
   */
  operationId: z.uuid(),
}).strict();
export const ControlRunCommandReceiptSchema = z
  .object({
    target: ManagedPeerSchema,
    accepted: z.literal(true),
    /** The turn this command became, so a caller can follow it in the session's own stream. */
    turnId: z.string().min(1).max(256),
    /** The exact text delivered, so a caller never has to guess how its arguments were framed. */
    text: z.string().min(1).max(4_224),
  })
  .strict();
export const ControlPermissionModeSchema = ControlTargetSchema.extend({
  /**
   * The caller's name for this request, so a retry is the same request rather than a second one.
   *
   * Carried here for the same reason as on rewind and MCP control: a mode change that was applied
   * but whose answer was lost must replay to the answer it already got, not start again against a
   * session that has since moved on.
   */
  operationId: z.uuid(),
  mode: PermissionModeSchema,
}).strict();
export const ControlPermissionModeReceiptSchema = z
  .object({ target: ManagedPeerSchema, mode: PermissionModeSchema })
  .strict();

export const ControlRewindSchema = ControlTargetSchema.extend({
  /** The user message to put the files back to, as the runtime's transcript identifies it. */
  messageId: z.uuid(),
  /** Preview only. The same code answers both, so what is previewed is what would happen. */
  dryRun: z.boolean().default(false),
  operationId: z.uuid(),
}).strict();
export const ControlRewindReceiptSchema = z
  .object({ target: ManagedPeerSchema, dryRun: z.boolean(), result: RewindResultSchema })
  .strict();

export const ControlMcpReadSchema = ControlTargetSchema.strict();
export const ControlMcpListSchema = z
  .object({ target: ManagedPeerSchema, data: z.array(NativeMcpServerSchema).max(64) })
  .strict();
export const ControlMcpControlSchema = ControlTargetSchema.extend({
  server: z.string().min(1).max(128),
  action: z.enum(['enable', 'disable', 'reconnect']),
  operationId: z.uuid(),
}).strict();
export const ControlMcpControlReceiptSchema = z
  .object({
    target: ManagedPeerSchema,
    server: z.string().min(1).max(128),
    /** What the server looks like AFTER the operation, not that the request was taken. */
    status: z.string().min(1).max(64),
  })
  .strict();

export const ControlWaitSchema = ControlTargetSchema.extend({
  timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
}).strict();
export const ControlWaitResultSchema = z
  .object({
    target: ManagedPeerSchema,
    outcome: z.enum(['idle', 'completed', 'interrupted', 'failed', 'timeout', 'unavailable']),
    state: ControlRowSchema.nullable(),
  })
  .strict();

/** A retained or delayed snapshot cannot extend the producer's observation lease. */
export function currentControlSnapshot(
  snapshot: ControlSnapshot,
  now = Date.now(),
): ControlSnapshot {
  const current = structuredClone(snapshot);
  if (Date.parse(current.observedAt) > now) {
    current.status = 'unavailable';
    current.reason = 'clock-skew';
  }
  if (current.status === 'live' && Date.parse(current.expiresAt) <= now) {
    current.status = 'stale';
    current.reason = 'observation-expired';
  }
  for (const row of current.sessions) {
    if (
      row.availability === 'live' &&
      (Date.parse(row.expiresAt) <= now ||
        Date.parse(row.observedAt) > now ||
        current.status !== 'live')
    ) {
      row.availability = current.status === 'unavailable' ? 'unavailable' : 'stale';
      row.state = 'unknown';
      row.reason = current.reason ?? 'observation-expired';
      if (row.applicationPolicy !== undefined) row.applicationPolicy.state = 'unavailable';
      delete row.nativeProfile;
    }
  }
  return current;
}
