import { createHash } from 'node:crypto';
import { AppError } from 'stitchkit';
import { supportsManagedInput } from '../agent/index.ts';
import { stableJson } from '../agent/launchInputs.ts';
import { withPinnedAttachments } from '../attachments/pins.ts';
import { buildEnvelope } from '../chat/compose.ts';
import { samePrincipal, sameTarget } from '../chat/identity.ts';
import { appendMessageOnce, loadLedger } from '../chat/store.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { withSessionRegistryLock } from '../config/registryLock.ts';
import { assertNoContextMutation } from '../context/store.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { hasNativeRuntime } from '../runtime/capabilities.ts';
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
  const target = controlTarget(m, input.target);
  const accept = () =>
    withSessionRegistryLock(m, async () => {
      signal.throwIfAborted();
      const session = controlTarget(m, input.target);
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
          prior.onBehalfOf !== null ||
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
        return {
          messageId: prior.id,
          accepted: true as const,
          duplicate: true,
          turnOptions: prior.turnOptions ?? null,
        };
      }
      if (!hasNativeRuntime(session) && (input.images.length > 0 || input.options !== undefined))
        throw new AppError('UNSUPPORTED', 'This runtime cannot accept structured turn input', 409);
      if (hasNativeRuntime(session)) assertNoContextMutation(m, session);
      const selection = hasNativeRuntime(session)
        ? await currentSelection(m, session, signal)
        : undefined;
      const turnOptions =
        selection === undefined
          ? undefined
          : { revision: selection.revision, options: input.options ?? selection.options };
      if (turnOptions !== undefined)
        await validateTurnOptions(m, session, turnOptions.options, signal, input.images.length > 0);
      const envelope = {
        ...buildEnvelope(from, input.target, input.body, {
          defer: input.defer,
          notBefore: input.notBefore,
          task: input.task,
        }),
        id: input.messageId,
        controlFingerprint: fingerprint,
        ...(turnOptions === undefined ? {} : { turnOptions }),
        ...(input.images.length === 0 ? {} : { images: input.images }),
      };
      signal.throwIfAborted();
      const append = () => appendMessageOnce(m, envelope, signal);
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
        accepted: true as const,
        duplicate: false,
        turnOptions: envelope.turnOptions ?? null,
      };
    });
  return hasNativeRuntime(target) ? withNativeAdmission(m, target, accept) : accept();
}
