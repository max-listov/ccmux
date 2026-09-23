import type { ChatTarget, MachineConfig } from '../types.ts';
import { promptInvocation } from '../util/env.ts';
import { log } from '../util/log.ts';
import { appendAck, loadAckedIds } from './ackLog.ts';
import { deliverCodexAppMessage } from './codexApp.ts';
import { type loadCursors, saveCursors } from './cursors.ts';
import { formatChatInjection } from './format.ts';
import { chatTargetKey, principalLabel, targetLabel } from './identity.ts';
import type { LedgerSlot } from './ledger.ts';
import { RATE_MAX_INBOUND, recentInboundCount } from './rateGuard.ts';
import { replyRouteToSender } from './replyRoute.ts';
import { isConditional, nextDelivery } from './settlement.ts';
import { armPickup, finishPickup } from './turnProgress.ts';

/**
 * The last hold reason logged for each App recipient.
 *
 * A held pickup is re-attempted every pass, and a condition that does not change — another client
 * holding the thread's writer while its operator works — restates itself once every three seconds
 * for as long as that work lasts. Six thousand identical lines in five hours record nothing; they
 * teach whoever greps the log that this message is noise, which is the same lesson a false "all
 * clear" teaches. So the line is written when the answer CHANGES, and again after a delivery.
 */
export const lastAppHold = new Map<string, string>();

/** Is this a new answer for that recipient? Records it when it is. Pure over the map it is given,
 *  so the rule can be exercised without the module's own state. */
export function holdChanged(seen: Map<string, string>, key: string, reason: string): boolean {
  if (seen.get(key) === reason) return false;
  seen.set(key, reason);
  return true;
}

export function noteAppHold(key: string, to: string, reason: string, level: 'info' | 'warn'): void {
  if (holdChanged(lastAppHold, key, reason))
    log[level]({ msg: 'Codex App chat pickup held', to, reason });
}

/**
 * The Codex App half of a delivery pass. App threads are ledger peers but not tmux sessions: the
 * shared App Server is their only writer boundary, and delivery uses the immutable client message id
 * as its crash-safe pickup proof. `budget` is what is left of the pass's delivery bound.
 */
export async function deliverAppPending(
  m: MachineConfig,
  ledger: readonly LedgerSlot[],
  cursors: ReturnType<typeof loadCursors>,
  acked: ReadonlySet<string>,
  now: number,
  budget: number,
): Promise<{ deliveries: number; changed: boolean }> {
  let deliveries = 0;
  let changed = false;
  const appRecipients = new Map<string, Extract<ChatTarget, { kind: 'codex-app' }>>();
  for (const slot of ledger) {
    if (slot?.to.kind !== 'codex-app' || slot.to.machine !== m.rcPrefix) continue;
    appRecipients.set(chatTargetKey(slot.to), slot.to);
  }
  for (const [recipientKey, recipient] of appRecipients) {
    if (deliveries >= budget) break;
    const activePickup = cursors.pickups[recipientKey];
    if (activePickup !== undefined) {
      const activeMessage = ledger.find((slot) => slot?.id === activePickup.messageId);
      if (activeMessage === null || activeMessage === undefined) continue;
      try {
        const text = formatChatInjection(activeMessage, {
          cli: promptInvocation(),
          reply: replyRouteToSender(m, activeMessage.from),
        });
        const result = await deliverCodexAppMessage(m, activeMessage, text);
        if (!result.delivered) {
          noteAppHold(recipientKey, targetLabel(recipient), result.reason, 'info');
          continue;
        }
        lastAppHold.delete(recipientKey);
        await finishPickup(m, cursors, recipientKey, recipient);
        deliveries += 1;
        log.info({
          msg: 'Codex App chat pickup completed',
          to: targetLabel(recipient),
          duplicate: result.duplicate,
        });
      } catch (error) {
        noteAppHold(
          recipientKey,
          targetLabel(recipient),
          `unavailable — barrier retained: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
      }
      continue;
    }
    const { pick, moved } = nextDelivery(ledger, recipientKey, cursors, acked, now);
    if (moved) changed = true;
    if (pick === null) continue;
    if (recentInboundCount(recipient, ledger, now) > RATE_MAX_INBOUND) {
      log.warn({
        msg: 'chat rate limit — holding App delivery (possible loop)',
        to: targetLabel(recipient),
      });
      continue;
    }
    if (isConditional(pick.msg) && loadAckedIds(m).has(pick.msg.id)) continue;
    try {
      const text = formatChatInjection(pick.msg, {
        cli: promptInvocation(),
        reply: replyRouteToSender(m, pick.msg.from),
      });
      armPickup(cursors, recipientKey, pick, new Date(now).toISOString());
      await saveCursors(m, cursors);
      // This barrier was created in this process immediately before the first submission, so there
      // is no prior accepted turn to scan for. A restarted process takes the activePickup path above
      // and performs the persisted client-id proof before it retries.
      const result = await deliverCodexAppMessage(m, pick.msg, text, undefined, async () => false);
      if (!result.delivered) {
        log.info({
          msg: 'Codex App chat delivery held',
          to: targetLabel(recipient),
          from: principalLabel(pick.msg.from),
          reason: result.reason,
        });
        continue;
      }
      if (isConditional(pick.msg)) appendAck(m, pick.msg.id, 'daemon', recipient);
      const { [recipientKey]: _completed, ...remaining } = cursors.pickups;
      cursors.pickups = remaining;
      changed = true;
      deliveries += 1;
      log.info({
        msg: 'chat delivered to Codex App',
        from: principalLabel(pick.msg.from),
        to: targetLabel(recipient),
        duplicate: result.duplicate,
      });
    } catch (error) {
      log.warn({
        msg: 'Codex App chat delivery unavailable — not acked',
        to: targetLabel(recipient),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { deliveries, changed };
}
