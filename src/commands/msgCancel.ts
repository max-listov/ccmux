import { appendAck, loadAcks } from '../chat/ackLog.ts';
import { loadCursors } from '../chat/cursors.ts';
import { principalLabel, sameSender } from '../chat/identity.ts';
import { loadLedger } from '../chat/ledger.ts';
import { pendingConditional, pendingImmediate } from '../chat/store.ts';
import { loadOutbox } from '../fleet/outbox.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';
import { promptInvocation } from '../util/env.ts';

/**
 *
 */
export async function msgCancel(
  machine: MachineConfig,
  from: ChatPrincipal,
  cancelTask: string | undefined,
): Promise<number> {
  if (!cancelTask) {
    console.log('usage: ccmux msg cancel <task>');
    return 1;
  }
  const ledger = loadLedger(machine);
  const acked = loadAcks(machine);
  const pending = pendingConditional(ledger, acked, {
    from,
    task: cancelTask,
  });
  for (const message of pending) appendAck(machine, message.id, 'cancel', message.to);
  if (pending.length > 0)
    console.log(
      `cancelled ${pending.length} undelivered message(s) from ${principalLabel(from)} for task '${cancelTask}'`,
    );
  else {
    // Zero used to be the whole answer, and it covered four different states at once: nothing of
    // mine is waiting, someone else's is, the task name is a typo, and — before `sameSender` —
    // "the life of this session that sent it is gone". Each needs a different next move, so each
    // is said.
    const others = pendingConditional(ledger, acked, { task: cancelTask });
    // The outbox counts as knowing the name. Without it a task whose only letters went to another
    // machine was announced as a typo — one line above the line saying where those letters went.
    const known =
      ledger.some((slot) => slot?.task === cancelTask) ||
      loadOutbox(machine).some((record) => record.envelope.task === cancelTask);
    if (others.length > 0) {
      const senders = [...new Set(others.map((msg) => principalLabel(msg.from)))].join(', ');
      console.log(
        `nothing of yours is waiting for '${cancelTask}': ${others.length} message(s) under that task belong to ${senders}, and only their own sender can retract them`,
      );
    } else if (known) {
      console.log(
        `nothing to cancel for '${cancelTask}': every message under that task has been delivered or already retracted`,
      );
    } else {
      console.log(
        `no task '${cancelTask}' in this machine’s ledger — check the name, or run ${promptInvocation()} msg pending to see what is waiting`,
      );
    }
  }
  const carried = pendingImmediate(ledger, loadCursors(machine), { from, task: cancelTask });
  if (carried.length > 0) {
    console.log(
      `${carried.length} immediate message(s) for '${cancelTask}' are still on their way — immediate mail has no withdrawal, it is handed over at the recipient's next opportunity`,
    );
  }
  // Cancel is local-only, exactly as `--after` is, and for the same reason: a letter to another
  // machine lives in THAT machine's ledger, so there is nothing here to tombstone. Saying it is
  // the whole point — "cancelled 0" is otherwise read as "nothing of mine is waiting", which is
  // the opposite of the truth for the one kind of mail a sender cannot see from here.
  const away = loadOutbox(machine).filter(
    (record) =>
      record.envelope.task === cancelTask &&
      sameSender(record.envelope.from, from) &&
      (record.envelope.to.kind === 'managed' || record.envelope.to.kind === 'codex-app') &&
      record.envelope.to.machine !== machine.rcPrefix,
  );
  if (away.length > 0) {
    console.log(
      `${away.length} message(s) for '${cancelTask}' went to another machine — cancel is local-only and cannot withdraw them there`,
    );
  }
  return 0;
}
