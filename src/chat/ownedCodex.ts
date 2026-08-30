import {
  appThreadHoldReason,
  prepareManagedCodexTurn,
  readCodexAppThread,
  resumeCodexAppThreadContext,
  startCodexAppTurn,
} from '../agent/codex/appServer.ts';
import { connectOwnedCodex } from '../agent/codex/ownedRpc.ts';
import { readOwnedCodexStatus } from '../agent/codex/ownedStatus.ts';
import { inspectNativeCodexInput } from '../agent/codex/pane.ts';
import { codexTextInput } from '../agent/codex/turnInput.ts';
import { clearChatHold, writeChatHold } from '../agent/sessionStatus.ts';
import { resolveMessageAttachments } from '../attachments/pins.ts';
import { loadSessions } from '../config/sessions.ts';
import { contextMutationPending } from '../context/store.ts';
import { promptInvocation } from '../env.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { capturePaneStyled, clientTypingRecently, setPaneInputEnabled } from '../tmux/tmux.ts';
import type { MachineConfig, Session } from '../types.ts';
import { log } from '../util/log.ts';
import { formatChatInjection } from './format.ts';
import { managedPeer, managedPeerKey } from './identity.ts';
import { findOwnedCodexReceipt } from './ownedCodexReceipt.ts';
import { conditionalMessage, pickPendingDelivery } from './pendingDelivery.ts';
import { replyRouteToSender } from './replyRoute.ts';
import { appendAck, type LedgerSlot, type loadCursors, saveCursors } from './store.ts';

type Cursors = ReturnType<typeof loadCursors>;
export const nativeDeliveryDependencies = {
  readStatus: readOwnedCodexStatus,
  connect: connectOwnedCodex,
  sessions: loadSessions,
  typing: clientTypingRecently,
  gate: setPaneInputEnabled,
  capture: capturePaneStyled,
  hold: writeChatHold,
  clearHold: clearChatHold,
  save: saveCursors,
  ack: appendAck,
};

/** The daemon is the sole cursor writer. All managed native submissions pass this same gate. */
export async function deliverOwnedCodexPending(
  m: MachineConfig,
  s: Session,
  ledger: readonly LedgerSlot[],
  cursors: Cursors,
  acked: ReadonlySet<string>,
  rateHeld: boolean,
  now = Date.now(),
  deps = nativeDeliveryDependencies,
): Promise<number> {
  return withNativeAdmission(m, s, () =>
    deliverLocked(m, s, ledger, cursors, acked, rateHeld, now, deps),
  );
}

async function deliverLocked(
  m: MachineConfig,
  s: Session,
  ledger: readonly LedgerSlot[],
  cursors: Cursors,
  acked: ReadonlySet<string>,
  rateHeld: boolean,
  now: number,
  deps: typeof nativeDeliveryDependencies,
): Promise<number> {
  const recipient = managedPeer(m.rcPrefix, s);
  const key = managedPeerKey(recipient);
  const pickup = cursors.pickups[key];
  const selected = pickPendingDelivery(ledger, key, cursors.delivered[key] ?? 0, acked, now);
  const pick = selected.pick;
  const messageId = pickup?.messageId ?? pick?.msg.id;
  if (messageId === undefined) return 0;
  const hold = (reason: string) => deps.hold(s.name, messageId, reason);
  const observed = deps.readStatus(m, s);
  if (observed.status !== 'live' || observed.snapshot === null) {
    await hold(`native runtime unavailable: ${observed.reason}`);
    return 0;
  }
  if (pickup?.native?.phase === 'accepted' && observed.snapshot.turn?.id === pickup.native.turnId) {
    if (observed.snapshot.turn.status === 'inProgress' || observed.snapshot.state !== 'idle')
      return 0;
    if (pickup.conditional) deps.ack(m, pickup.messageId, 'daemon', recipient);
    delete cursors.pickups[key];
    await deps.save(m, cursors);
    deps.clearHold(s.name);
    return 0;
  }
  if (pickup !== undefined) {
    const rpc = await deps.connect(m, s);
    try {
      const receipt = await findOwnedCodexReceipt(rpc, s.uuid, pickup.messageId);
      if (receipt === null) {
        await hold('native acceptance is indeterminate; automatic resubmission is blocked');
        return 0;
      }
      pickup.native = { phase: 'accepted', turnId: receipt.id };
      if (receipt.status !== 'inProgress' && observed.snapshot.state === 'idle') {
        if (pickup.conditional) deps.ack(m, pickup.messageId, 'daemon', recipient);
        delete cursors.pickups[key];
        deps.clearHold(s.name);
      }
      await deps.save(m, cursors);
      return 0;
    } finally {
      rpc.close();
    }
  }
  if (pick === null) return 0;
  if (contextMutationPending(m, s)) {
    await hold('native context operation is unresolved');
    return 0;
  }
  if (rateHeld) {
    await hold('native chat inbound rate limit');
    return 0;
  }
  if (observed.snapshot.state !== 'idle') {
    await hold(`native runtime is ${observed.snapshot.state}`);
    return 0;
  }
  if (await deps.typing(m, s.name, 3)) {
    await hold('a human typed in that pane a moment ago');
    return 0;
  }
  const rpc = await deps.connect(m, s);
  let gated = false;
  try {
    gated = await deps.gate(m, s.name, false);
    if (!gated) {
      await hold('native client input could not be gated');
      return 0;
    }
    const inspection = inspectNativeCodexInput(await deps.capture(m, s.name, 40));
    if (inspection?.state !== 'deliverable') {
      await hold(inspection?.reason ?? 'native client readiness unavailable');
      return 0;
    }
    const context =
      s.launchRecipe?.collaborationMode === undefined && pick.msg.turnOptions === undefined
        ? { thread: await readCodexAppThread(rpc, s.uuid) }
        : await resumeCodexAppThreadContext(rpc, s.uuid);
    const thread = context.thread;
    const reason = appThreadHoldReason(thread);
    if (reason !== null || thread.status.type !== 'idle') {
      await hold(reason ?? 'native runtime is not idle');
      return 0;
    }
    const currentIdentity = deps.sessions(m).find((row) => row.name === s.name);
    if (
      currentIdentity?.uuid !== s.uuid ||
      currentIdentity.agent !== s.agent ||
      currentIdentity.runtime !== s.runtime ||
      currentIdentity.registrationGeneration !== s.registrationGeneration
    ) {
      await hold('managed identity changed before native submission');
      return 0;
    }
    let policy: Awaited<ReturnType<typeof prepareManagedCodexTurn>>;
    try {
      policy = await prepareManagedCodexTurn(rpc, m, s, context, pick.msg.turnOptions?.options);
    } catch {
      await hold('managed collaboration policy is unavailable');
      return 0;
    }
    const attachments = pick.msg.images?.length
      ? await resolveMessageAttachments(
          m,
          s,
          pick.msg.id,
          pick.msg.images,
          AbortSignal.timeout(5_000),
        )
      : [];
    const conditional = conditionalMessage(pick.msg);
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
    await deps.save(m, cursors);
    const text = formatChatInjection(pick.msg, {
      cli: promptInvocation(),
      reply: replyRouteToSender(m, pick.msg.from),
    });
    const input = codexTextInput(text);
    for (const attachment of attachments) input.push({ type: 'localImage', path: attachment.path });
    const turnId = await startCodexAppTurn(rpc, s.uuid, pick.msg.id, input, policy);
    const current = cursors.pickups[key];
    if (current === undefined) throw new Error('Native pickup intent disappeared');
    current.native = { phase: 'accepted', turnId };
    await deps.save(m, cursors);
    deps.clearHold(s.name);
    log.info({ msg: 'native managed chat accepted', name: s.name, messageId: pick.msg.id, turnId });
    return 1;
  } finally {
    if (gated) await deps.gate(m, s.name, true);
    rpc.close();
  }
}
