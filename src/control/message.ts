import { createHash } from 'node:crypto';
import { AppError } from 'stitchkit';
import { supportsManagedInput } from '../agent/index.ts';
import { stableJson } from '../agent/launch/launchInputs.ts';
import { withPinnedAttachments } from '../attachments/pins.ts';
import {
  requireCommunicationAuthorization,
  requireOriginatingBasis,
} from '../chat/communicationAuthorization.ts';
import { buildEnvelope } from '../chat/compose.ts';
import { samePrincipal, sameTarget } from '../chat/identity.ts';
import { appendMessageOnce, loadLedger } from '../chat/ledger.ts';
import { localMessageLookup } from '../chat/localMessages.ts';
import { advanceMessageOperation, prepareMessageOperation } from '../chat/messageOperationStore.ts';
import { admitMessageOrigin } from '../chat/origin.ts';
import { unknownMessageOrigin } from '../chat/originSchema.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { assertNoContextMutation } from '../context/store.ts';
import { requireApplicationInput } from '../delegation/application.ts';
import { delegationStopped } from '../delegation/cancel.ts';
import { delegationRefused } from '../delegation/resolve.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import { withSessionRegistryLock } from '../session/registryLock.ts';
import { wakeSleepingSession } from '../session/sleep/operations.ts';
import { readSleep } from '../session/sleep/store.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';
import { type ControlMessage, ControlMessageSchema } from './schema/message.ts';
import { refusals } from './schema/refusals.ts';
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
  const communicationReceipt = requireOriginatingBasis(
    from,
    input.target,
    input.communicationAuthorization,
    // Only a caller whose records live here can have a reference resolved against them.
    from.machine === m.rcPrefix ? localMessageLookup(m) : null,
    input.task,
  );
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
          throw refusals.errors.IDENTITY_MISMATCH({
            message: 'The exact managed registration is unavailable',
          });
        // Attributed input pins the registration it addresses for native sessions so a human's
        // message cannot land on a replaced native runtime. Ordinary TUI panes now receive
        // backfilled registrationGeneration for sleep/wake exactness, so requiring it here would
        // break existing human-origin callers addressing plain panes (mismatch is still refused
        // above whenever a caller does supply registrationGeneration).
        if (
          hasNativeRuntime(session) &&
          input.origin !== undefined &&
          session.registrationGeneration !== undefined &&
          input.registrationGeneration === undefined
        )
          throw refusals.errors.VALIDATION_ERROR({
            message: 'Attributed input requires registration generation',
          });
        const notification = input.notification ?? 'conversation';
        const origin = admitMessageOrigin(m, from, input.origin, notification);
        if (!chatEnabledFor(session, m) || !supportsManagedInput(session)) {
          throw refusals.errors.CHAT_DISABLED({
            message: 'Target cannot receive managed messages',
          });
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
            throw refusals.errors.IDEMPOTENCY_CONFLICT({
              message: 'Message ID already belongs to a different request',
            });
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
        if (session.delegation?.applicationAuthority !== undefined) {
          if (from.kind === 'managed') {
            const parent = controlTarget(m, from);
            if (
              session.delegation.parent.target.kind !== 'managed' ||
              !sameTarget(from, session.delegation.parent.target) ||
              parent.registrationGeneration !== session.delegation.parent.registrationGeneration ||
              stableJson(parent.delegation?.applicationAuthority) !==
                stableJson(session.delegation.applicationAuthority) ||
              delegationStopped(m, parent)
            )
              delegationRefused(
                'Managed input requires the exact active application descendant parent',
              );
          } else {
            requireApplicationInput(
              m,
              from,
              session.delegation.applicationAuthority,
              input.origin,
              input.communicationAuthorization,
            );
          }
        }
        if (hasNativeRuntime(session)) {
          const sleeping = readSleep(m, session);
          if (sleeping !== null && sleeping.phase !== 'awake')
            throw refusals.errors.SESSION_SLEEPING({
              message: 'Session must wake before input admission',
            });
        }
        if (!hasNativeRuntime(session) && (input.images.length > 0 || input.options !== undefined))
          throw refusals.errors.UNSUPPORTED({
            message: 'This runtime cannot accept structured turn input',
          });
        // A declared capability nobody checks is worse than no capability: images were admitted for
        // every native runtime, pinned, receipted as accepted, and then dropped by a runtime that
        // never reads them. The caller saw success and the model never saw the image.
        if (input.images.length > 0 && !runtimeCapabilities(session).imageInput)
          throw refusals.errors.UNSUPPORTED({ message: 'This runtime cannot accept image input' });
        if (delegationStopped(m, session)) delegationRefused('Delegated work has ended');
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
          ...(communicationReceipt === undefined
            ? {}
            : {
                communicationReceipt: {
                  ...communicationReceipt,
                  rootMessageId: communicationReceipt.rootMessageId ?? input.messageId,
                },
              }),
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
          throw refusals.errors.IDEMPOTENCY_CONFLICT({
            message: 'Message identity changed during acceptance; reconcile before retry',
          });
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
  if (!hasNativeRuntime(target)) return accept();
  for (;;) {
    signal.throwIfAborted();
    try {
      return await withNativeAdmission(m, target, accept);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'SESSION_SLEEPING') throw error;
      await wakeSleepingSession(m, target, signal);
    }
  }
}
