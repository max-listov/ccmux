import { ApiError, type ClientFetch, createClient } from 'stitchkit';
import { defineContract } from 'stitchkit/contract';
import { z } from 'zod';
import { AttachmentReferenceSchema } from '../attachments/reference.ts';
import {
  AttachmentBeginSchema,
  AttachmentCancelReceiptSchema,
  AttachmentChunkSchema,
  AttachmentReadReceiptSchema,
  AttachmentReadSchema,
  AttachmentUploadReceiptSchema,
  AttachmentUploadSelectorSchema,
} from '../attachments/schema.ts';
import {
  MessageOperationReadSchema,
  MessageOperationResultSchema,
} from '../chat/messageOperationSchema.ts';
import { NativeForkRequestSchema } from '../context/schema.ts';
import {
  ExternalContentCapabilitiesSchema,
  ExternalContentReadSchema,
  ExternalContentResultSchema,
  ExternalContentSelectorSchema,
} from '../external/contentSchema.ts';
import { RuntimeCatalogInputSchema, RuntimeCatalogSchema } from '../runtime/capabilities.ts';
import {
  SteeringInputSchema,
  SteeringReadResultSchema,
  SteeringReceiptSchema,
  SteeringSelectorSchema,
} from '../steering/schema.ts';
import {
  ControlCompactSchema,
  ControlContextOperationReadSchema,
  ControlContextOperationResultSchema,
  ControlHistoryReadSchema,
  ControlHistoryResultSchema,
} from './contextSchema.ts';
import { ControlDirectoryReadSchema, ControlDirectoryResultSchema } from './directorySchema.ts';
import {
  ControlActionReceiptSchema,
  ControlArchiveReceiptSchema,
  ControlCreateReceiptSchema,
  ControlCreateSchema,
  ControlInterruptSchema,
  ControlMessageCancelReceiptSchema,
  ControlMessageCancelSchema,
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
  ControlTranscriptReadSchema,
  ControlTranscriptResultSchema,
  ControlWaitResultSchema,
} from './schema.ts';
import {
  SelectionReadSchema,
  SelectionResultSchema,
  SelectionUpdateSchema,
} from './selectionSchema.ts';
import {
  CCMUX_CONTROL_SERVICE_BASE_URL,
  CCMUX_CONTROL_SERVICE_PREFIX,
  ControlServiceOperationSchema,
  ControlServiceReplyEnvelopeSchema,
  ControlServiceWaitSchema,
  controlServiceEffects,
  controlServiceInputs,
} from './serviceCatalog.ts';
import { serviceOperation } from './serviceDescriptor.ts';

/**
 * The declared input of the endpoint that serves this operation.
 *
 * Keyed by the wire path, because that is what the operation id IS — the contract and the catalog
 * are two indexes over one set of schemas, and reading the contract here keeps the pre-flight check
 * spoken in the same language as the request it guards.
 */
function contractInput(operation: string): z.ZodType | null {
  for (const endpoint of Object.values(ccmuxControlServiceContract.endpoints))
    if (endpoint.path.slice(1) === operation) return (endpoint.input ?? null) as z.ZodType | null;
  return null;
}

/**
 * The field names one parse failure is about.
 *
 * Usually the issue's own path. The exception is an unrecognized key on a strict object, which is
 * how a client older than the daemon fails: the path stops at the OBJECT, and the names that were
 * not expected sit in the issue instead. Reporting only the path there says "evidence" where the
 * answer is "evidence.hold" — enough to know something is wrong, not enough to know it is a version
 * behind. These are keys the schema declined, so they are names and never values.
 */
export function issueFields(issue: z.core.$ZodIssue): string[] {
  const at = issue.path.map(String);
  if (issue.code === 'unrecognized_keys')
    return issue.keys.map((key) => [...at, key].join('.') || key);
  return [at.join('.') || '(root)'];
}

function serviceReply<T>(result: z.ZodType<T>) {
  return ControlServiceReplyEnvelopeSchema.transform((envelope, ctx): T => {
    const parsed = result.safeParse(envelope.result);
    if (!parsed.success) {
      // WHICH fields did not match. The parse knows exactly — path, code, what was expected — and
      // this used to throw all of it away for one sentence with an empty path. A consumer then
      // could not tell "your client is older than this daemon" from "the service is broken", which
      // is the difference between updating a package and filing a defect: one of them cost a
      // round trip through a person to answer a question this code already had in hand.
      //
      // The FIELDS, never their values, exactly as on the request side: a value can carry someone's
      // message body, and a mismatch is identified by where it is, not by what was there.
      ctx.addIssue({
        code: 'custom',
        message: `owner service returned a result this client cannot read; these fields did not match: ${[
          ...new Set(parsed.error.issues.flatMap(issueFields)),
        ]
          .slice(0, 12)
          .join(', ')}`,
      });
      return z.NEVER;
    }
    return parsed.data;
  });
}

export const ccmuxControlServiceContract = defineContract(
  { prefix: CCMUX_CONTROL_SERVICE_PREFIX },
  {
    externalHistory: {
      method: 'POST',
      path: '/external.history',
      desc: 'Read bounded authored text without claiming an external writer',
      input: ExternalContentReadSchema,
      output: serviceReply(ExternalContentResultSchema),
      idempotent: true,
      timeout: 7_000,
      meta: { effect: controlServiceEffects['external.history'] },
    },
    externalCapabilities: {
      method: 'POST',
      path: '/external.capabilities',
      desc: 'Read exact external content and control eligibility',
      input: ExternalContentSelectorSchema,
      output: serviceReply(ExternalContentCapabilitiesSchema),
      idempotent: true,
      timeout: 7_000,
      meta: { effect: controlServiceEffects['external.capabilities'] },
    },
    messageOperation: {
      method: 'POST',
      path: '/message.operation',
      desc: 'Read retained exact message-to-native-turn evidence without resubmission',
      input: MessageOperationReadSchema,
      output: serviceReply(MessageOperationResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['message.operation'] },
    },
    transcript: {
      method: 'POST',
      path: '/transcript.read',
      desc: 'Read a bounded transcript window with the cursor a caller pages by',
      input: ControlTranscriptReadSchema,
      output: serviceReply(ControlTranscriptResultSchema),
      idempotent: true,
      timeout: 7_000,
      meta: { effect: controlServiceEffects['transcript.read'] },
    },
    messageCancel: {
      method: 'POST',
      path: '/message.cancel',
      desc: 'Withdraw one accepted letter of the caller that has not been delivered',
      input: ControlMessageCancelSchema,
      output: serviceReply(ControlMessageCancelReceiptSchema),
      idempotent: true,
      timeout: 7_000,
      meta: { effect: controlServiceEffects['message.cancel'] },
    },
    history: {
      method: 'POST',
      path: '/history.read',
      desc: 'Read a bounded native history page',
      input: ControlHistoryReadSchema,
      output: serviceReply(ControlHistoryResultSchema),
      idempotent: true,
      timeout: 7_000,
      meta: { effect: controlServiceEffects['history.read'] },
    },
    compact: {
      method: 'POST',
      path: '/context.compact',
      desc: 'Accept exact idle native compaction',
      input: ControlCompactSchema,
      output: serviceReply(ControlContextOperationResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['context.compact'] },
    },
    contextOperation: {
      method: 'POST',
      path: '/context.operation',
      desc: 'Read durable compaction evidence',
      input: ControlContextOperationReadSchema,
      output: serviceReply(ControlContextOperationResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['context.operation'] },
    },
    fork: {
      method: 'POST',
      path: '/session.fork',
      desc: 'Fork an exact idle native conversation',
      input: NativeForkRequestSchema,
      output: serviceReply(ControlCreateReceiptSchema),
      idempotent: true,
      timeout: 30_000,
      meta: { effect: controlServiceEffects['session.fork'] },
    },
    steer: {
      method: 'POST',
      path: '/turn.steer',
      desc: 'Submit content to an exact active native turn',
      input: SteeringInputSchema,
      output: serviceReply(SteeringReceiptSchema),
      idempotent: true,
      timeout: 15_000,
      meta: { effect: controlServiceEffects['turn.steer'] },
    },
    steeringOperation: {
      method: 'POST',
      path: '/turn.steering-operation',
      desc: 'Read exact steering acceptance',
      input: SteeringSelectorSchema,
      output: serviceReply(SteeringReadResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['turn.steering-operation'] },
    },
    selection: {
      method: 'POST',
      path: '/selection.read',
      desc: 'Read revisioned native turn defaults for an exact registration',
      input: SelectionReadSchema,
      output: serviceReply(SelectionResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['selection.read'] },
    },
    select: {
      method: 'POST',
      path: '/selection.update',
      desc: 'Compare-and-swap native turn defaults between turns',
      input: SelectionUpdateSchema,
      output: serviceReply(SelectionResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['selection.update'] },
    },
    attachmentBegin: {
      method: 'POST',
      path: '/attachment.begin',
      desc: 'Reserve an authenticated bounded image upload',
      input: AttachmentBeginSchema,
      output: serviceReply(AttachmentUploadReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['attachment.begin'] },
    },
    attachmentChunk: {
      method: 'POST',
      path: '/attachment.chunk',
      desc: 'Append one authenticated bounded image chunk',
      input: AttachmentChunkSchema,
      output: serviceReply(AttachmentUploadReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['attachment.chunk'] },
    },
    attachmentFinalize: {
      method: 'POST',
      path: '/attachment.finalize',
      desc: 'Decode and verify complete image bytes',
      input: AttachmentUploadSelectorSchema,
      output: serviceReply(AttachmentReferenceSchema),
      idempotent: true,
      timeout: 15_000,
      meta: { effect: controlServiceEffects['attachment.finalize'] },
    },
    attachmentCancel: {
      method: 'POST',
      path: '/attachment.cancel',
      desc: 'Cancel only unretained image bytes',
      input: AttachmentUploadSelectorSchema,
      output: serviceReply(AttachmentCancelReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['attachment.cancel'] },
    },
    attachmentRead: {
      method: 'POST',
      path: '/attachment.read',
      desc: 'Read an authenticated bounded image preview',
      input: AttachmentReadSchema,
      output: serviceReply(AttachmentReadReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['attachment.read'] },
    },
    runtimes: {
      method: 'POST',
      path: '/runtime.list',
      desc: 'Discover configured execution runtimes and capabilities',
      input: RuntimeCatalogInputSchema,
      output: serviceReply(RuntimeCatalogSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['runtime.list'] },
    },
    get: {
      method: 'POST',
      path: '/session.get',
      desc: 'Read one exact managed session',
      input: ControlTargetSchema,
      output: serviceReply(ControlRowSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['session.get'] },
    },
    directories: {
      method: 'POST',
      path: '/directory.list',
      desc: 'Read a bounded directory page',
      input: ControlDirectoryReadSchema,
      output: serviceReply(ControlDirectoryResultSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['directory.list'] },
    },
    create: {
      method: 'POST',
      path: '/session.create',
      desc: 'Idempotently create one managed Codex session',
      input: ControlCreateSchema,
      output: serviceReply(ControlCreateReceiptSchema),
      idempotent: true,
      timeout: 30_000,
      meta: { effect: controlServiceEffects['session.create'] },
    },
    archive: {
      method: 'POST',
      path: '/session.archive',
      desc: 'Archive one exact managed identity',
      input: ControlTargetSchema,
      output: serviceReply(ControlArchiveReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['session.archive'] },
    },
    message: {
      method: 'POST',
      path: '/message.send',
      desc: 'Accept one identity-pinned durable message',
      input: ControlMessageSchema,
      output: serviceReply(ControlMessageReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['message.send'] },
    },
    start: {
      method: 'POST',
      path: '/session.start',
      desc: 'Start one existing managed identity',
      input: ControlTargetSchema,
      output: serviceReply(ControlActionReceiptSchema),
      meta: { effect: controlServiceEffects['session.start'] },
    },
    interrupt: {
      method: 'POST',
      path: '/turn.interrupt',
      desc: 'Interrupt one exact active native turn',
      input: ControlInterruptSchema,
      output: serviceReply(ControlActionReceiptSchema),
      meta: { effect: controlServiceEffects['turn.interrupt'] },
    },
    native: {
      method: 'POST',
      path: '/native.read',
      desc: 'Read bounded native items after a cursor',
      input: ControlNativeReadSchema,
      output: serviceReply(ControlNativeSnapshotSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['native.read'] },
    },
    respond: {
      method: 'POST',
      path: '/native.respond',
      desc: 'Answer one exact current native request',
      input: ControlNativeResponseSchema,
      output: serviceReply(ControlNativeResponseReceiptSchema),
      idempotent: true,
      meta: { effect: controlServiceEffects['native.respond'] },
    },
    wait: {
      method: 'POST',
      path: '/session.wait',
      desc: 'Wait for a managed native session between turns',
      input: ControlServiceWaitSchema,
      output: serviceReply(ControlWaitResultSchema),
      idempotent: true,
      timeout: 30_000,
      meta: { effect: controlServiceEffects['session.wait'] },
    },
    models: {
      method: 'POST',
      path: '/model.list',
      desc: 'Read the selected runtime model catalog with explicit source identity',
      input: ControlModelsReadSchema,
      output: serviceReply(ControlModelCatalogSchema),
      idempotent: true,
      timeout: 10_000,
      meta: { effect: controlServiceEffects['model.list'] },
    },
  },
);

/** The composing transport supplies delivery. No socket, credential or retry is implicit. */
export function createCcmuxControlServiceClient(fetch: ClientFetch, timeoutMs = 30_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
    throw new Error('Invalid client deadline');
  return createClient(ccmuxControlServiceContract, {
    baseUrl: CCMUX_CONTROL_SERVICE_BASE_URL,
    timeout: timeoutMs,
    fetch: async (url, init) => {
      const route = new URL(String(url));
      if (
        route.origin !== CCMUX_CONTROL_SERVICE_BASE_URL ||
        !route.pathname.startsWith(`${CCMUX_CONTROL_SERVICE_PREFIX}/`) ||
        route.search !== '' ||
        init?.method !== 'POST'
      )
        throw new ApiError('INVALID_OPERATION');
      const operation = ControlServiceOperationSchema.parse(
        route.pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
      );
      const body = typeof init.body === 'string' ? init.body : '{}';
      const limit = serviceOperation(operation).limits.requestBytes;
      if (new TextEncoder().encode(body).byteLength > limit)
        throw new ApiError('REQUEST_TOO_LARGE');
      let decoded: unknown;
      try {
        decoded = JSON.parse(body);
      } catch {
        throw new ApiError('INVALID_INPUT', 0, undefined, 'request body is not JSON');
      }
      // The schema the CONTRACT declares for this endpoint — the very one this client is about to
      // speak, not a second index of the same fact. `input` is optional on an endpoint, so an
      // operation that declares none has nothing to refuse.
      //
      // `safeParse` does not always answer: a schema runs caller code inside the parse — a
      // `preprocess`, or a `refine` predicate — and such code can THROW rather than return a
      // verdict. A gate that crashes instead of refusing is worse than no gate: the caller gets an
      // exception with no code and no field. So an unanswerable schema is treated as one that had
      // nothing to say, and the server keeps the last word it always had. Reported by the contract
      // framework's owner, who measured it on the very idiom their own guide recommends.
      //
      // No test stages it, because nothing here throws today, and that is measured rather than
      // assumed: walking all twenty-eight input schemas finds no `preprocess` and no type that
      // loses itself across JSON, and the seven predicates it does find read fields the base schema
      // has already parsed. They are also the reason the guard exists — a predicate is the one
      // place in this contract where a future author can put code that throws, and it will not look
      // like a decision about this gate when they do.
      const schema = contractInput(operation) ?? controlServiceInputs[operation];
      const parsed = ((): z.ZodSafeParseResult<unknown> => {
        try {
          return schema.safeParse(decoded);
        } catch {
          return { success: true, data: decoded };
        }
      })();
      if (!parsed.success)
        // The FIELDS, never their values: a caller that sent the wrong shape needs to know which
        // part of it, and a value can carry someone's message body. Bare `INVALID_INPUT` reads like
        // a refusal rather than a malformed request — a consumer sending a truncated target spent a
        // minute looking for a missing permission, because the code alone cannot tell those apart.
        throw new ApiError(
          'INVALID_INPUT',
          0,
          undefined,
          `these fields are wrong or missing: ${[
            ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
          ]
            .slice(0, 12)
            .join(', ')}`,
        );
      return fetch(url, { ...init, body: JSON.stringify(parsed.data) });
    },
  });
}

export type { ClientFetch } from 'stitchkit';
export { ApiError } from 'stitchkit';
