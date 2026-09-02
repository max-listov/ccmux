import type { z } from 'zod';
import { readChatHold } from '../agent/sessionStatus.ts';
import {
  MessageOperationReadSchema,
  MessageOperationResultSchema,
} from '../chat/messageOperationSchema.ts';
import { messagePrincipal, readMessageJournal } from '../chat/messageOperationStore.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';

import type { ChatPrincipal, MachineConfig } from '../types.ts';
import { controlTarget } from './target.ts';

/** Bounded metadata only: no provider call, transcript read, replay, or mutation on this path. */
export function readMessageOperation(
  m: MachineConfig,
  principal: ChatPrincipal,
  request: z.output<typeof MessageOperationReadSchema>,
  now = Date.now(),
) {
  const input = MessageOperationReadSchema.parse(request);
  const unavailable = () =>
    MessageOperationResultSchema.parse({ ...input, outcome: 'unavailable', evidence: null });
  try {
    const s = controlTarget(m, input.target);
    if (!hasNativeRuntime(s) || s.registrationGeneration !== input.registrationGeneration)
      return unavailable();
    const journal = readMessageJournal(m, s);
    const record = journal?.records.find(
      (item) =>
        item.messageId === input.messageId && item.principal === messagePrincipal(principal),
    );
    if (!journal || !record) return unavailable();
    if (record.expiresAt !== null && Date.parse(record.expiresAt) <= now)
      return MessageOperationResultSchema.parse({ ...input, outcome: 'expired', evidence: null });
    // A small local read, no provider call and no pane capture: this path stays bounded metadata.
    const hold = readChatHold(s.name);
    return MessageOperationResultSchema.parse({
      ...input,
      outcome: 'available',
      evidence: {
        state: record.phase === 'preparing' ? 'uncertain' : record.phase,
        nativeSession: journal.nativeSession,
        turnId: record.turnId,
        continuations: record.continuations,
        pendingApprovals: record.pendingApprovals,
        observedAt: record.observedAt,
        expiresAt: record.expiresAt,
        // Only about THIS letter. The daemon keeps one hold per recipient — the message it last
        // tried — so stamping that reason onto any waiting letter would confidently explain one
        // letter with another letter's evidence. A hold about something else is not evidence here,
        // and null says "not currently held", never "moving".
        hold:
          hold !== null && hold.msgId === input.messageId
            ? { kind: hold.kind, text: hold.reason.slice(0, 512), heldForMs: hold.heldForMs }
            : null,
      },
    });
  } catch {
    return unavailable();
  }
}
