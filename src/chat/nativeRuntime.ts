import { contextMutationPending } from '../context/store.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import {
  inputTurnId,
  readRuntimeInput,
  runtimeInputId,
  writeRuntimeInput,
} from '../runtime/input.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import { loadSessions } from '../session/registry.ts';
import { clearChatHold, readChatHold, writeChatHold } from '../session/status.ts';
import type { MachineConfig, Session } from '../types.ts';
import { promptInvocation } from '../util/env.ts';
import { appendAck } from './ackLog.ts';
import { type loadCursors, saveCursors } from './cursors.ts';
import { formatChatInjection } from './format.ts';
import { managedPeer, managedPeerKey } from './identity.ts';
import type { LedgerSlot } from './ledger.ts';
import { advanceMessageOperation } from './messageOperationStore.ts';
import { replyRouteToSender } from './replyRoute.ts';
import { nativeDeliveryHold, pendingMessageId, pickPendingDelivery } from './settlement.ts';
import { armPickup } from './turnProgress.ts';

/** How long a queued letter may sit untaken beside an idle runtime before the owner is named. */
const OWNER_SILENT_MS = 30_000;

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
  try {
    return await withNativeAdmission(m, s, () =>
      deliverLocked(m, s, ledger, cursors, acked, rateHeld, now),
    );
  } catch (error) {
    const held = pendingMessageId(
      ledger,
      managedPeerKey(managedPeer(m.rcPrefix, s)),
      cursors,
      acked,
      now,
    );
    if (held !== undefined) await writeChatHold(s.name, held, nativeDeliveryHold(error));
    throw error;
  }
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
  const messageId = pendingMessageId(ledger, key, cursors, acked, now);
  if (messageId === undefined) return 0;
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
          (s.agent === 'custom'
            ? input.terminal !== undefined
            : read.snapshot.turn?.id === inputTurnId(input) &&
              read.snapshot.turn.status !== 'inProgress'));
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
          nativeId: runtimeInputId(s, slot.id, Date.parse(pickup.injectedAt)),
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
      else if (
        input.phase === 'queued' &&
        read.snapshot.state === 'idle' &&
        now - Date.parse(pickup.injectedAt) > OWNER_SILENT_MS &&
        readChatHold(s.name)?.msgId !== pickup.messageId
      )
        // An owner that is held by something says what, every tick. One that says nothing while its
        // runtime sits idle is not reading the slot at all — which is what an owner started by an
        // earlier version of ccmux does, since it predates this mailbox.
        await hold(
          `the session's owner has not taken this letter; an owner started by an earlier ccmux takes none — ccmux restart ${s.name}`,
        );
      return 0;
    }
    const turnId = inputTurnId(input);
    pickup.native = { phase: 'accepted', turnId };
    advanceMessageOperation(m, s, pickup.messageId, 'admitted', turnId, now);
    const currentTurnId = input.continuations.at(-1)?.turnId ?? turnId;
    const terminal =
      s.agent === 'custom'
        ? input.terminal !== undefined
        : read.snapshot.turn?.id === currentTurnId && read.snapshot.turn.status !== 'inProgress';
    if (terminal && read.snapshot.state === 'idle') {
      const turn = read.snapshot.turn;
      if (turn !== null && turn.status !== 'inProgress')
        advanceMessageOperation(m, s, pickup.messageId, input.terminal ?? turn.status, turnId, now);
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
  advanceMessageOperation(m, s, pick.msg.id, 'uncertain', null, now);
  armPickup(cursors, key, pick, new Date(now).toISOString(), {
    native: { phase: 'intent', turnId: null },
  });
  await saveCursors(m, cursors);
  await writeRuntimeInput(m, s, {
    messageId: pick.msg.id,
    nativeId: runtimeInputId(s, pick.msg.id, now),
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
