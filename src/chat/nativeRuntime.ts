import { clearChatHold, writeChatHold } from '../agent/sessionStatus.ts';
import { loadSessions } from '../config/sessions.ts';
import { contextMutationPending } from '../context/store.ts';
import { promptInvocation } from '../env.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { openCodeMessageId, readRuntimeInput, writeRuntimeInput } from '../runtime/input.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import type { MachineConfig, Session } from '../types.ts';
import { formatChatInjection } from './format.ts';
import { managedPeer, managedPeerKey } from './identity.ts';
import { advanceMessageOperation } from './messageOperationStore.ts';
import { conditionalMessage, pickPendingDelivery } from './pendingDelivery.ts';
import { replyRouteToSender } from './replyRoute.ts';
import { appendAck, type LedgerSlot, type loadCursors, saveCursors } from './store.ts';

/** Existing chat ledger is the only queue. The runtime mailbox is one durable dispatch receipt. */
export async function deliverNativeRuntimePending(
  m: MachineConfig,
  s: Session,
  ledger: readonly LedgerSlot[],
  cursors: ReturnType<typeof loadCursors>,
  acked: ReadonlySet<string>,
  rateHeld: boolean,
  now = Date.now(),
): Promise<number> {
  return withNativeAdmission(m, s, () =>
    deliverLocked(m, s, ledger, cursors, acked, rateHeld, now),
  );
}

async function deliverLocked(
  m: MachineConfig,
  s: Session,
  ledger: readonly LedgerSlot[],
  cursors: ReturnType<typeof loadCursors>,
  acked: ReadonlySet<string>,
  rateHeld: boolean,
  now: number,
): Promise<number> {
  const recipient = managedPeer(m.rcPrefix, s);
  const key = managedPeerKey(recipient);
  const pickup = cursors.pickups[key];
  const pick = pickPendingDelivery(ledger, key, cursors.delivered[key] ?? 0, acked, now).pick;
  const messageId = pickup?.messageId ?? pick?.msg.id;
  if (!messageId) return 0;
  const hold = (reason: string) => writeChatHold(s.name, messageId, reason);
  const read = readManagedRuntimeStatus(m, s);
  if (read.status !== 'live' || read.snapshot === null) {
    await hold('native runtime is unavailable');
    return 0;
  }
  const current = loadSessions(m).find((row) => row.name === s.name);
  if (
    current?.uuid !== s.uuid ||
    current.registrationGeneration !== s.registrationGeneration ||
    current.nativeSession?.id !== s.nativeSession?.id
  )
    throw new Error('Managed identity changed before native dispatch');
  const input = readRuntimeInput(m, s);
  if (pickup !== undefined) {
    if (input?.messageId !== pickup.messageId) {
      const previousComplete =
        input === null ||
        (input.phase === 'accepted' &&
          read.snapshot.turn?.id === input.nativeId &&
          read.snapshot.turn.status !== 'inProgress');
      const slot = pickup.ledgerIndex === null ? null : ledger[pickup.ledgerIndex];
      if (
        pickup.native?.phase === 'intent' &&
        previousComplete &&
        read.snapshot.state === 'idle' &&
        slot?.id === pickup.messageId
      ) {
        if (contextMutationPending(m, s)) {
          await hold('native context operation is unresolved');
          return 0;
        }
        // Cursor intent is durable before the mailbox. A crash in between is safe to repair only
        // when no unresolved native dispatch exists; corrupt or uncertain receipts never replay.
        await writeRuntimeInput(m, s, {
          messageId: slot.id,
          nativeId: openCodeMessageId(slot.id, Date.parse(pickup.injectedAt)),
          images: slot.images,
          turnOptions: slot.turnOptions,
          phase: 'queued',
          text: formatChatInjection(slot, {
            cli: promptInvocation(),
            reply: replyRouteToSender(m, slot.from),
          }),
        });
        return 1;
      }
      await hold('native dispatch receipt is unavailable');
      return 0;
    }
    if (input.phase !== 'accepted') {
      if (input.phase === 'uncertain')
        await hold('native acceptance is indeterminate; automatic resubmission is blocked');
      return 0;
    }
    pickup.native = { phase: 'accepted', turnId: input.nativeId };
    advanceMessageOperation(m, s, pickup.messageId, 'admitted', input.nativeId, now);
    const terminal =
      read.snapshot.turn?.id === input.nativeId && read.snapshot.turn.status !== 'inProgress';
    if (terminal && read.snapshot.state === 'idle') {
      const turn = read.snapshot.turn;
      if (turn !== null && turn.status !== 'inProgress')
        advanceMessageOperation(m, s, pickup.messageId, turn.status, input.nativeId, now);
      if (pickup.conditional) appendAck(m, pickup.messageId, 'daemon', recipient);
      delete cursors.pickups[key];
      clearChatHold(s.name);
    }
    await saveCursors(m, cursors);
    return 0;
  }
  if (pick === null) return 0;
  if (contextMutationPending(m, s)) {
    await hold('native context operation is unresolved');
    return 0;
  }
  if (rateHeld || read.snapshot.state !== 'idle' || read.snapshot.turn?.status === 'inProgress') {
    await hold(
      rateHeld ? 'native chat inbound rate limit' : `native runtime is ${read.snapshot.state}`,
    );
    return 0;
  }
  const conditional = conditionalMessage(pick.msg);
  advanceMessageOperation(m, s, pick.msg.id, 'uncertain', null, now);
  cursors.pickups[key] = {
    messageId: pick.msg.id,
    ledgerIndex: pick.idx,
    conditional,
    injectedAt: new Date(now).toISOString(),
    native: { phase: 'intent', turnId: null },
  };
  if (!conditional) {
    cursors.delivered[key] = pick.idx + 1;
    cursors.read[key] = Math.max(cursors.read[key] ?? 0, pick.idx + 1);
  }
  await saveCursors(m, cursors);
  await writeRuntimeInput(m, s, {
    messageId: pick.msg.id,
    nativeId: openCodeMessageId(pick.msg.id, now),
    phase: 'queued',
    images: pick.msg.images,
    turnOptions: pick.msg.turnOptions,
    text: formatChatInjection(pick.msg, {
      cli: promptInvocation(),
      reply: replyRouteToSender(m, pick.msg.from),
    }),
  });
  clearChatHold(s.name);
  return 1;
}
