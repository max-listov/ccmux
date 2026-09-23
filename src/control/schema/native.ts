import { z } from 'zod';
import { LaunchRecipeMetadataSchema, NativeSessionSchema } from '../../config/launchSchema.ts';
import { ContentCursorSchema, ContentReadSchema } from '../../content/schema.ts';
import { TranscriptJsonSchema } from '../../context/transcriptJsonSchema.ts';
import { ApplicationPolicyEvidenceSchema } from '../../policy/reference.ts';
import { RuntimeAppliedProfileSchema } from '../../policy/runtimeProfile.ts';
import { RuntimeCapabilitiesSchema } from '../../runtime/capabilities.ts';
import { NativePendingRequestSchema } from '../../runtime/projectionSchema.ts';
import {
  AcceptedTurnOptionsSchema,
  NativeSelectionEvidenceSchema,
} from '../../runtime/selectionSchema.ts';
import { ControlTargetSchema } from './core.ts';

/**
 * A transcript window asked for over the control plane.
 *
 * The same three questions the command line accepts — the newest `tail`, everything after a
 * `cursor`, a page `before` a line — because they are the same question, and a second vocabulary
 * for it would mean two ways to page through one conversation.
 *
 * Bounded here rather than downstream: this answer travels a response budget, and a caller asking
 * for two thousand messages at full text would be refused by the transport with a size error that
 * says nothing about what to ask for instead.
 */
export const ControlTranscriptReadSchema = ControlTargetSchema.extend({
  tail: z.number().int().min(1).max(200).default(120),
  cursor: z.number().int().nonnegative().nullable().default(null),
  before: z.number().int().positive().nullable().default(null),
  limit: z.number().int().min(1).max(200).nullable().default(null),
  // Wide enough for a whole report: an agent's final answer or a task notification carrying one
  // runs past 8 KB, and a consumer that parses either needs it intact, not cut mid-tag.
  textLimit: z.number().int().min(1).max(65_536).nullable().default(null),
  /** Read the transcript of the agent this session spawned, by the id its `Agent` call carries. */
  agent: z
    .string()
    .regex(/^[0-9a-f]{1,64}$/)
    .nullable()
    .default(null),
}).strict();
export const ControlTranscriptResultSchema = TranscriptJsonSchema.extend(
  ControlTargetSchema.shape,
).strict();

export const ControlNativeCursorSchema = ContentCursorSchema;
export const ControlNativeReadSchema = ControlTargetSchema.extend({
  cursor: ControlNativeCursorSchema.nullable().default(null),
}).strict();
export const ControlNativeSnapshotSchema = ContentReadSchema.extend({
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  pending: z.array(NativePendingRequestSchema.omit({ rpcId: true })).max(16),
  /**
   * How many pending requests exist that this snapshot does not carry.
   *
   * A pending request is bounded but not small: four questions of thirty-two options each is a
   * legal approval prompt and is larger on its own than a native stream frame is allowed to be. The
   * daemon never sheds one — it reads what the runtime asked — but the stream producer must, and
   * without a count the shed would be a lie: an empty `pending` reads as "the session is asking
   * nothing" while it sits blocked on a question. This says the difference out loud, the same way
   * `omittedRecords` does for content.
   */
  omittedPending: z.number().int().nonnegative(),
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
