import { continuationRef } from '../chat/communicationAuthorizationSchema.ts';
import { principalLabel, samePrincipal, sameSender, targetLabel } from '../chat/identity.ts';
import { loadLedger } from '../chat/ledger.ts';
import { loadOutboxAcked, RETRY_WINDOW_MS } from '../fleet/flush.ts';
import { loadOutbox } from '../fleet/outbox.ts';
import type { ChatMessage, ChatPrincipal, MachineConfig } from '../types.ts';
import { humanizeDuration } from '../util/duration.ts';
import { preview } from '../util/preview.ts';
import { printLine } from '../util/stdout.ts';
import { tableLines } from '../util/table.ts';

/**
 * What this session SENT, and under which reference. `pending` answers "what has not arrived yet";
 * this answers "what did I send" — and in particular the one value a thread-continuation has to
 * name, which used to exist only in the recipient's copy of the letter.
 *
 * Both halves are read for the same reason `localMessageLookup` reads both: mail to a session on
 * this machine lands in the chat ledger, while mail sent abroad exists here only as an outbound
 * envelope, because cross-machine mail is stored in the RECIPIENT's ledger.
 */
export async function msgSent(
  machine: MachineConfig,
  from: ChatPrincipal,
  wanted: string | undefined,
  asJson: boolean,
): Promise<number> {
  // A letter's own state decides whether its reference is offered, and the two halves know it
  // differently. A letter to a session on THIS machine is in the recipient's ledger the moment it
  // is written — there is no transport to fail, and WHEN the recipient is shown it is `pending`'s
  // question, not this one. A letter abroad is only an attempt until transit settles it: the
  // record says whether the far side accepted it, and the ack log says which later retry did.
  const acked = loadOutboxAcked(machine);
  const settled = Date.now();
  const states = new Map<string, 'accepted' | 'held' | 'undelivered'>();
  const collected = new Map<string, ChatMessage>();
  const note = (message: ChatMessage, state: 'accepted' | 'held' | 'undelivered') => {
    collected.set(message.id, message);
    // One id can hold several outbox rows — an attempt and its retries — so acceptance wins over
    // any earlier failure rather than depending on which row is read last.
    if (states.get(message.id) !== 'accepted') states.set(message.id, state);
  };
  for (const slot of loadLedger(machine)) if (slot !== null) note(slot, 'accepted');
  for (const record of loadOutbox(machine))
    note(
      record.envelope,
      record.result.ok || acked.has(record.envelope.id)
        ? 'accepted'
        : settled - Date.parse(record.envelope.ts) > RETRY_WINDOW_MS
          ? 'undelivered'
          : 'held',
    );
  const mine = [...collected.values()]
    .filter((message) => sameSender(message.from, from))
    .filter((message) => wanted === undefined || message.task === wanted)
    .sort((left, right) => left.ts.localeCompare(right.ts));
  // Offered only for a letter that reached the recipient's ledger. A letter still held for retry
  // has an id and a record here, but it has not opened a correspondence, and a continuation of one
  // that never arrived is the claim this reference must not help anyone make.
  const refOf = (message: ChatMessage): string | null =>
    states.get(message.id) === 'accepted' ? continuationRef(message) : null;
  // A continuation references the LIFE that wrote the letter, not the session name: a restart or a
  // renewed conversation gives the same `machine:session` a new thread, and `resolveCommunicationBasis`
  // compares the full principal. Listing an older life's letters here would hand out references
  // that are refused on use, which is the failure this command exists to end.
  const current = mine.filter((message) => samePrincipal(message.from, from));
  const earlier = mine.length - current.length;
  if (asJson) {
    // One line, through the writer that waits for the pipe, like every other `--json` here.
    await printLine(
      JSON.stringify({
        sender: principalLabel(from),
        sent: current.map((message) => ({
          ref: refOf(message),
          state: states.get(message.id) ?? 'accepted',
          id: message.id,
          thread:
            message.to.kind === 'managed' || message.to.kind === 'codex-app'
              ? message.to.threadId
              : null,
          to: targetLabel(message.to),
          task: message.task,
          ts: message.ts,
          preview: preview(message.body),
        })),
        fromEarlierLives: earlier,
      }),
    );
    return 0;
  }
  if (current.length === 0) {
    console.log(
      wanted === undefined
        ? `nothing sent by ${principalLabel(from)} is recorded on this machine`
        : `nothing sent by ${principalLabel(from)} for task '${wanted}'`,
    );
  } else {
    const now = Date.now();
    const rows = current.map((message) => [
      humanizeDuration((now - Date.parse(message.ts)) / 1000),
      message.task ?? '-',
      targetLabel(message.to),
      states.get(message.id) ?? 'accepted',
      refOf(message) ?? '-',
      // One row, one line: a letter's own newlines would otherwise split the row and leave the
      // columns of every following line meaningless — and a reference read out of a broken table
      // is the reference that gets mistyped.
      preview(message.body).replace(/\s+/g, ' '),
    ]);
    for (const line of tableLines(['AGE', 'TASK', 'TO', 'STATE', 'REF', 'TEXT'], rows))
      console.log(line);
    console.log(
      'REF is the sourceMessageRef of a thread-continuation to that recipient under that task. It is offered only for a letter that reached the recipient\u2019s ledger: one still held for retry has not opened a correspondence, and a letter to the owner has no reference at all',
    );
  }
  if (earlier > 0)
    console.log(
      `${earlier} more were sent by earlier lives of this session — a continuation references the life that wrote the letter, so their references no longer resolve`,
    );
  return 0;
}
