import { AppError } from "stitchkit";
import { providerFor } from "../agent/index.ts";
import { buildEnvelope } from "../chat/compose.ts";
import { samePrincipal, sameTarget } from "../chat/identity.ts";
import { appendMessageOnce, loadLedger } from "../chat/store.ts";
import { chatEnabledFor } from "../config/chat.ts";
import { withSessionRegistryLock } from "../config/registryLock.ts";
import type { ChatPrincipal, MachineConfig } from "../types.ts";
import type { ControlMessage } from "./schema.ts";
import { controlTarget } from "./target.ts";

export async function acceptControlMessage(m: MachineConfig, from: ChatPrincipal, input: ControlMessage, signal: AbortSignal) {
  return withSessionRegistryLock(m, async () => {
    signal.throwIfAborted();
    const session = controlTarget(m, input.target);
    if (!chatEnabledFor(session, m) || providerFor(session).inspectChatPane === undefined) {
      throw new AppError("CHAT_DISABLED", "Target cannot receive managed messages", 409);
    }
    const prior = loadLedger(m).find((item) => item?.id === input.messageId);
    if (prior) {
      if (!samePrincipal(prior.from, from) || !sameTarget(prior.to, input.target) || prior.body !== input.body
        || prior.defer !== input.defer || prior.notBefore !== input.notBefore || prior.task !== input.task || prior.onBehalfOf !== null) {
        throw new AppError("IDEMPOTENCY_CONFLICT", "Message ID already belongs to a different request", 409);
      }
      return { messageId: prior.id, accepted: true, duplicate: true } satisfies { messageId: string; accepted: true; duplicate: boolean };
    }
    const envelope = { ...buildEnvelope(from, input.target, input.body,
      { defer: input.defer, notBefore: input.notBefore, task: input.task }), id: input.messageId };
    signal.throwIfAborted();
    const appended = await appendMessageOnce(m, envelope, signal);
    if (!appended) throw new AppError("IDEMPOTENCY_CONFLICT", "Message identity changed during acceptance; reconcile before retry", 409);
    return { messageId: envelope.id, accepted: true, duplicate: false } satisfies { messageId: string; accepted: true; duplicate: boolean };
  });
}
