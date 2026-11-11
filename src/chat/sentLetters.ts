import type { z } from 'zod';
import { loadOutboxAcked, loadOutboxRefused, RETRY_WINDOW_MS } from '../fleet/flush.ts';
import { loadOutbox } from '../fleet/outbox.ts';
import type { ChatMessage, ChatPrincipal, MachineConfig } from '../types.ts';
import { principalLabel, samePrincipal, sameSender } from './identity.ts';
import { loadLedger } from './ledger.ts';
import {
  type SentLetter,
  type SentLetterState,
  type SentListSchema,
  sentLetter,
} from './sentLetterSchema.ts';

/**
 * What this session SENT, and under which reference. `pending` answers "what has not arrived yet";
 * this answers "what did I send" — and in particular the one value a thread-continuation has to
 * name, which used to exist only in the recipient's copy of the letter.
 *
 * Both halves are read for the same reason `localMessageLookup` reads both: mail to a session on
 * this machine lands in the chat ledger, while mail sent abroad exists here only as an outbound
 * envelope, because cross-machine mail is stored in the RECIPIENT's ledger.
 */
export function sentLetters(
  machine: MachineConfig,
  from: ChatPrincipal,
  wanted: string | undefined,
): z.infer<typeof SentListSchema> {
  // A letter's own state decides whether its reference is offered, and the two halves know it
  // differently. A letter to a session on THIS machine is in the recipient's ledger the moment it
  // is written — there is no transport to fail, and WHEN the recipient is shown it is `pending`'s
  // question, not this one. A letter abroad is only an attempt until transit settles it: the
  // record says whether the far side accepted it, and the ack log says which later retry did.
  const acked = loadOutboxAcked(machine);
  const refused = loadOutboxRefused(machine);
  const settled = Date.now();
  const states = new Map<string, SentLetterState>();
  const collected = new Map<string, ChatMessage>();
  const note = (message: ChatMessage, state: SentLetterState) => {
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
        : refused.has(record.envelope.id)
          ? 'refused'
          : settled - Date.parse(record.envelope.ts) > RETRY_WINDOW_MS
            ? 'undelivered'
            : 'held',
    );
  const mine = [...collected.values()]
    .filter((message) => sameSender(message.from, from))
    .filter((message) => wanted === undefined || message.task === wanted)
    .sort((left, right) => left.ts.localeCompare(right.ts));
  // A continuation references the LIFE that wrote the letter, not the session name: a restart or a
  // renewed conversation gives the same `machine:session` a new thread, and `resolveCommunicationBasis`
  // compares the full principal. Listing an older life's letters here would hand out references
  // that are refused on use, which is the failure this command exists to end.
  const current = mine.filter((message) => samePrincipal(message.from, from));
  // A reference is offered only for a letter that reached the recipient's ledger. One still held
  // for retry has an id and a record here, but it has not opened a correspondence, and a
  // continuation of one that never arrived is the claim this reference must not help anyone make.
  return {
    sender: principalLabel(from),
    sent: current.map(
      (message): SentLetter => sentLetter(message, states.get(message.id) ?? 'accepted'),
    ),
    fromEarlierLives: mine.length - current.length,
  };
}
