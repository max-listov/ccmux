import { createHash } from 'node:crypto';
import { AppError } from 'stitchkit';
import { supportsManagedInput } from '../agent/index.ts';
import { stableJson } from '../agent/launchInputs.ts';
import { withPinnedAttachments } from '../attachments/pins.ts';
import { requireCommunicationAuthorization } from '../chat/communicationAuthorization.ts';
import { buildEnvelope } from '../chat/compose.ts';
import { samePrincipal, sameTarget } from '../chat/identity.ts';
import { advanceMessageOperation, prepareMessageOperation } from '../chat/messageOperationStore.ts';
import { admitMessageOrigin } from '../chat/origin.ts';
import { unknownMessageOrigin } from '../chat/originSchema.ts';
import { appendMessageOnce, loadLedger } from '../chat/store.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { withSessionRegistryLock } from '../config/registryLock.ts';
import { assertNoContextMutation } from '../context/store.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';
import { type ControlMessage, ControlMessageSchema } from './schema.ts';
import { currentSelection, validateTurnOptions } from './selection.ts';
import { controlTarget } from './target.ts';

export async function acceptControlMessage(
  m: MachineConfig,
  from: ChatPrincipal,
  request: ControlMessage,
  signal: AbortSignal,
) {
  const input = ControlMessageSchema.parse(request);
  const admittedOrigin = admitMessageOrigin(
    m,
    from,
    input.origin,
    input.notification ?? 'conversation',
  );
  requireCommunicationAuthorization(from, admittedOrigin, input.communicationAuthorization);
  const target = controlTarget(m, input.target);
  const accept = () =>
    withSessionRegistryLock(
      m,
      async () => {
        signal.throwIfAborted();
        const session = controlTarget(m, input.target);
        if (
          input.registrationGeneration !== undefined &&
          input.registrationGeneration !== session.registrationGeneration
        )
          throw new AppError(
            'IDENTITY_MISMATCH',
            'The exact managed registration is unavailable',
            409,
          );
        // Attributed input pins the registration it addresses, so a human's message cannot land on a
        // session that was replaced underneath it. Asked here rather than of the request alone,
        // because the answer depends on the target: a session without a generation has nothing to
        // pin, and demanding one of it refuses every ordinary pane — which is every session an
        // application would write a human's message to.
        if (
          input.origin !== undefined &&
          session.registrationGeneration !== undefined &&
          input.registrationGeneration === undefined
        )
          throw new AppError(
            'VALIDATION_ERROR',
            'Attributed input requires registration generation',
            400,
          );
        const notification = input.notification ?? 'conversation';
        const origin = admitMessageOrigin(m, from, input.origin, notification);
        if (!chatEnabledFor(session, m) || !supportsManagedInput(session)) {
          throw new AppError('CHAT_DISABLED', 'Target cannot receive managed messages', 409);
        }
        const fingerprint = createHash('sha256').update(stableJson(input)).digest('hex');
        const prior = loadLedger(m).find((item) => item?.id === input.messageId);
        if (prior) {
          if (
            !samePrincipal(prior.from, from) ||
            !sameTarget(prior.to, input.target) ||
            prior.body !== input.body ||
            prior.defer !== input.defer ||
            prior.notBefore !== input.notBefore ||
            prior.task !== input.task ||
            stableJson(prior.communicationAuthorization ?? null) !==
              stableJson(input.communicationAuthorization) ||
            prior.onBehalfOf !== null ||
            (prior.origin !== undefined && stableJson(prior.origin) !== stableJson(origin)) ||
            (prior.notification !== undefined && prior.notification !== notification) ||
            (prior.controlFingerprint !== undefined
              ? prior.controlFingerprint !== fingerprint
              : input.images.length > 0 || input.options !== undefined)
          ) {
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              'Message ID already belongs to a different request',
              409,
            );
          }
          if (hasNativeRuntime(session)) advanceMessageOperation(m, session, prior.id, 'queued');
          return {
            messageId: prior.id,
            origin: prior.origin ?? unknownMessageOrigin(),
            notification: prior.notification ?? 'conversation',
            registrationGeneration: prior.registrationGeneration ?? null,
            accepted: true as const,
            duplicate: true,
            turnOptions: prior.turnOptions ?? null,
          };
        }
        if (!hasNativeRuntime(session) && (input.images.length > 0 || input.options !== undefined))
          throw new AppError(
            'UNSUPPORTED',
            'This runtime cannot accept structured turn input',
            409,
          );
        // A declared capability nobody checks is worse than no capability: images were admitted for
        // every native runtime, pinned, receipted as accepted, and then dropped by a runtime that
        // never reads them. The caller saw success and the model never saw the image.
        if (input.images.length > 0 && !runtimeCapabilities(session).imageInput)
          throw new AppError('UNSUPPORTED', 'This runtime cannot accept image input', 409);
        if (hasNativeRuntime(session)) assertNoContextMutation(m, session);
        const selection = hasNativeRuntime(session)
          ? await currentSelection(m, session, signal)
          : undefined;
        const turnOptions =
          selection === undefined
            ? undefined
            : { revision: selection.revision, options: input.options ?? selection.options };
        if (turnOptions !== undefined)
          await validateTurnOptions(
            m,
            session,
            turnOptions.options,
            signal,
            input.images.length > 0,
          );
        const envelope = {
          ...buildEnvelope(from, input.target, input.body, {
            defer: input.defer,
            notBefore: input.notBefore,
            task: input.task,
            communicationAuthorization: input.communicationAuthorization,
          }),
          id: input.messageId,
          origin,
          notification,
          ...(session.registrationGeneration === undefined
            ? {}
            : { registrationGeneration: session.registrationGeneration }),
          controlFingerprint: fingerprint,
          ...(turnOptions === undefined ? {} : { turnOptions }),
          ...(input.images.length === 0 ? {} : { images: input.images }),
        };
        signal.throwIfAborted();
        const append = async () => {
          if (hasNativeRuntime(session))
            prepareMessageOperation(m, session, from, input.messageId, fingerprint);
          const appended = await appendMessageOnce(m, envelope, signal);
          if (appended && hasNativeRuntime(session))
            advanceMessageOperation(m, session, input.messageId, 'queued');
          return appended;
        };
        const appended =
          input.images.length === 0
            ? await append()
            : await withPinnedAttachments(
                m,
                from,
                input.target,
                input.messageId,
                input.images,
                append,
                signal,
              );
        if (!appended)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'Message identity changed during acceptance; reconcile before retry',
            409,
          );
        return {
          messageId: envelope.id,
          origin,
          notification,
          registrationGeneration: envelope.registrationGeneration ?? null,
          accepted: true as const,
          duplicate: false,
          turnOptions: envelope.turnOptions ?? null,
        };
      },
      signal,
    );
  return hasNativeRuntime(target) ? withNativeAdmission(m, target, accept) : accept();
}
