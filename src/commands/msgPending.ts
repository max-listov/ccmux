import { loadAcks } from '../chat/ackLog.ts';
import { loadCursors } from '../chat/cursors.ts';
import { chatTargetKey, principalLabel, sameSender, targetLabel } from '../chat/identity.ts';
import { loadLedger } from '../chat/ledger.ts';
import { deliverableTargets, pendingConditional, pendingImmediate } from '../chat/store.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';
import { humanizeDuration } from '../util/duration.ts';
import { preview } from '../util/preview.ts';
import { tableLines } from '../util/table.ts';

/**
 * What is waiting, before anyone asks what to withdraw. Without it the queue could only be acted
 * on blindly: `cancel` was the only way to learn anything about outstanding mail, and it answered
 * with a number that meant four different things.
 */
export function msgPending(
  machine: MachineConfig,
  from: ChatPrincipal,
  wanted: string | undefined,
): number {
  const ledger = loadLedger(machine);
  const live = deliverableTargets(machine);
  const waiting = [
    ...pendingConditional(
      ledger,
      loadAcks(machine),
      wanted === undefined ? { live } : { task: wanted, live },
    ).map((msg) => ({
      msg,
      kind: msg.notBefore !== null ? 'timer' : 'deferred',
    })),
    ...pendingImmediate(
      ledger,
      loadCursors(machine),
      wanted === undefined ? { live } : { task: wanted, live },
    ).map((msg) => ({
      msg,
      kind: 'immediate',
    })),
  ].sort((left, right) => left.msg.ts.localeCompare(right.msg.ts));
  // Counted separately and never mixed into the queue: a letter whose recipient was removed is
  // not waiting, but it is not nothing either — somebody wrote it and nobody will ever read it.
  // Folding it into "waiting" said a colleague was owed an answer; dropping it silently would
  // hide that a letter was lost. It is history now, and history is what the ledger keeps.
  const stranded = [
    ...pendingConditional(ledger, loadAcks(machine), wanted === undefined ? {} : { task: wanted }),
    ...pendingImmediate(ledger, loadCursors(machine), wanted === undefined ? {} : { task: wanted }),
  ].filter((msg) => msg.to.kind === 'managed' && !live.has(chatTargetKey(msg.to))).length;
  const strandedLine =
    stranded === 0
      ? null
      : `${stranded} letter(s) can never be delivered — the session they were addressed to no longer exists`;
  if (waiting.length === 0) {
    console.log(
      wanted === undefined
        ? 'nothing is waiting: every message in this machine’s ledger has been handed over'
        : `nothing is waiting for task '${wanted}'`,
    );
    if (strandedLine !== null) console.log(strandedLine);
    return 0;
  }
  const now = Date.now();
  const rows = waiting.map(({ msg, kind }) => [
    humanizeDuration((now - Date.parse(msg.ts)) / 1000),
    kind,
    principalLabel(msg.from),
    targetLabel(msg.to),
    msg.task ?? '-',
    preview(msg.body),
  ]);
  for (const line of tableLines(['AGE', 'KIND', 'FROM', 'TO', 'TASK', 'TEXT'], rows))
    console.log(line);
  // A letter cannot be withdrawn by a stranger, and after a restart the sender's own new life used
  // to be one. It no longer is — but a letter from ANOTHER session still is, and saying so here is
  // what keeps the reader from concluding the queue is stuck.
  const mine = waiting.filter(({ msg }) => sameSender(msg.from, from)).length;
  if (mine < waiting.length)
    console.log(
      `${waiting.length - mine} of these were sent by another session; only their own sender can retract them`,
    );
  if (strandedLine !== null) console.log(strandedLine);
  return 0;
}
