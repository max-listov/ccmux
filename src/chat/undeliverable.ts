import { statSync } from 'node:fs';
import { chatLedgerPath, sessionsPath } from '../config/paths.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import { appendAck, loadAcks } from './ackLog.ts';
import { loadCursors, saveCursors } from './cursors.ts';
import { chatTargetKey, targetLabel } from './identity.ts';
import { loadLedger } from './ledger.ts';
import { isConditional, letterState } from './settlement.ts';
import { deliverableTargets } from './store.ts';

/**
 * Settle the letters nobody will ever pick up.
 *
 * Delivery walks the LIVE sessions, so a letter addressed to a session that has since been removed
 * is not waiting for anything — it is simply never looked at again. Left alone it accumulates: on
 * one machine eighteen such letters sat in the queue for three weeks, reported on every `msg
 * pending` as mail a colleague is still owed. That line trains its reader to scroll past the one
 * place that says what has not arrived.
 *
 * Settled, not deleted. The ledger is append-only and keeps every letter that was ever sent; what
 * ends here is the WAITING, and the record of how it ended is the ack row itself.
 *
 * Both tracks have to be closed, because they are settled by different things and always were: a
 * conditional letter stops being pending when its id is in the ack log, while an immediate one
 * stops only when the recipient's delivery cursor passes its index. An earlier attempt that
 * tombstoned and called it done left the immediate half exactly where it was.
 */
/**
 * What the last completed pass saw, so an unchanged queue costs two `stat` calls instead of a
 * parse. Keyed by ledger path: one entry per machine in this process, and a fixture gets its own.
 *
 * Measured before this existed: 40–270 ms per pass on a 5 MB ledger, every three seconds, settling
 * nothing — on the daemon's own event loop, which has a stall watchdog. Nothing is missed by the
 * skip: removing a session rewrites the registry and a new letter grows the ledger, so either
 * change moves one of the two stamps.
 */
const lastPass = new Map<string, string>();

function stamp(path: string): string {
  try {
    const info = statSync(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'absent';
  }
}

export async function settleUndeliverable(m: MachineConfig): Promise<number> {
  const ledgerPath = chatLedgerPath(m);
  const seen = `${stamp(ledgerPath)}|${stamp(sessionsPath(m))}`;
  if (lastPass.get(ledgerPath) === seen) return 0;
  const live = deliverableTargets(m);
  const ledger = loadLedger(m);
  const acks = loadAcks(m);
  const cursors = loadCursors(m);
  // One cursor per dead recipient, moved past its last letter. The entry outlives the session it
  // names, which is the price of the cursor being an index into an append-only ledger: it is a
  // number per removed session, written once.
  const advanced = new Map<string, number>();
  let settled = 0;
  for (const [index, message] of ledger.entries()) {
    // Only managed recipients are judged: an App thread is addressed from the ledger itself rather
    // than from this machine's session registry, so its absence here means nothing.
    if (message === null || message.to.kind !== 'managed') continue;
    const key = chatTargetKey(message.to);
    if (live.has(key)) continue;
    if (letterState(message, index, acks, cursors) !== 'pending') continue;
    // Settled on the track that owns it: a conditional letter in the ack log, an immediate one by
    // moving its recipient's cursor past it.
    if (isConditional(message)) appendAck(m, message.id, 'undeliverable', message.to);
    else advanced.set(key, Math.max(advanced.get(key) ?? 0, index + 1));
    settled++;
    log.info({
      msg: 'chat letter settled as undeliverable — the recipient no longer exists',
      id: message.id,
      to: targetLabel(message.to),
      task: message.task,
      sentAt: message.ts,
    });
  }
  if (advanced.size > 0) {
    for (const [key, next] of advanced)
      cursors.delivered[key] = Math.max(cursors.delivered[key] ?? 0, next);
    await saveCursors(m, cursors);
  }
  // Recorded only after the pass completed: a throw halfway through must leave the next tick
  // looking again, not trusting a scan that did not finish.
  lastPass.set(ledgerPath, `${stamp(ledgerPath)}|${stamp(sessionsPath(m))}`);
  return settled;
}
