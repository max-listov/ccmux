import { loadOutboxAcked } from '../fleet/flush.ts';
import { loadOutbox } from '../fleet/outbox.ts';
import type { MachineConfig } from '../types.ts';
import type { LocalMessageLookup, LocalMessageRecord } from './communicationBasis.ts';
import { loadLedger } from './ledger.ts';

/**
 * Every message THIS machine holds a record of, by id.
 *
 * Both files are read because the two halves of a correspondence live apart: mail addressed to a
 * session here lands in the chat ledger, while mail this machine sent to another machine exists
 * only as an outbound envelope — cross-machine mail is stored in the RECIPIENT's ledger. Reading
 * the ledger alone would answer "no record" for every letter we sent abroad, which is precisely the
 * half a continuation points at.
 *
 * The two halves differ in one fact a caller must not have to reconstruct. A ledger entry is already
 * in a recipient's ledger — for a session on this machine that ledger IS this one, and an incoming
 * letter is here because it arrived. An outbound envelope is an ATTEMPT until transit settles it:
 * the record says whether the far side accepted it, and the ack log says which later retry did.
 */
export function localMessageLookup(m: MachineConfig): LocalMessageLookup {
  let index: Map<string, LocalMessageRecord> | null = null;
  return (id: string) => {
    if (index === null) {
      index = new Map();
      for (const slot of loadLedger(m))
        if (slot !== null) index.set(slot.id, { message: slot, reachedRecipient: true });
      const acked = loadOutboxAcked(m);
      for (const sent of loadOutbox(m)) {
        const reachedRecipient = sent.result.ok || acked.has(sent.envelope.id);
        // Attempt and retries share one id, so acceptance wins over any earlier failure rather than
        // depending on which row happens to be read last.
        if (index.get(sent.envelope.id)?.reachedRecipient === true) continue;
        index.set(sent.envelope.id, { message: sent.envelope, reachedRecipient });
      }
    }
    return index.get(id) ?? null;
  };
}
