import { loadOutbox } from '../fleet/outbox.ts';
import type { ChatMessage, MachineConfig } from '../types.ts';
import type { LocalMessageLookup } from './communicationBasis.ts';
import { loadLedger } from './store.ts';

/**
 * Every message THIS machine holds a record of, by id.
 *
 * Both files are read because the two halves of a correspondence live apart: mail addressed to a
 * session here lands in the chat ledger, while mail this machine sent to another machine exists
 * only as an outbound envelope — cross-machine mail is stored in the RECIPIENT's ledger. Reading
 * the ledger alone would answer "no record" for every letter we sent abroad, which is precisely the
 * half a continuation points at.
 */
export function localMessageLookup(m: MachineConfig): LocalMessageLookup {
  let index: Map<string, ChatMessage> | null = null;
  return (id: string) => {
    if (index === null) {
      index = new Map();
      for (const slot of loadLedger(m)) if (slot !== null) index.set(slot.id, slot);
      for (const sent of loadOutbox(m)) index.set(sent.envelope.id, sent.envelope);
    }
    return index.get(id) ?? null;
  };
}
