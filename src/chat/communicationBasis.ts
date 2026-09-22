import { AppError } from 'stitchkit';
import type { ChatMessage } from '../types.ts';
import type { CommunicationAuthorization } from './communicationAuthorizationSchema.ts';
import { parseLedgerMessageRef } from './communicationAuthorizationSchema.ts';
import type { CommunicationReceipt } from './communicationReceiptSchema.ts';
import { chatPrincipalKey, chatTargetKey } from './identity.ts';
import type { ChatPrincipal, ChatTarget } from './identitySchema.ts';

/**
 * One record this machine holds, WITH the fact that decides whether it can be built on.
 *
 * `reachedRecipient` is not bookkeeping: a letter this machine failed to deliver abroad still has an
 * id, a record and a complete receipt here, and every other check a continuation makes passes on it.
 * Resolving one would let a sender open a correspondence out of a letter nobody ever received — the
 * permission would rest on a conversation that never started. The originating host is the only place
 * that knows the difference, which is the same reason references are resolved here at all.
 */
export type LocalMessageRecord = { message: ChatMessage; reachedRecipient: boolean };
export type LocalMessageLookup = (id: string) => LocalMessageRecord | null;

function refuse(message: string): never {
  throw new AppError('COMMUNICATION_AUTHORIZATION_UNVERIFIED', message, 403);
}

function threadOf(party: ChatPrincipal | ChatTarget): string | null {
  return party.kind === 'managed' || party.kind === 'codex-app' ? party.threadId : null;
}

/** Resolve only against the originating host's records. A remote receiver cannot attest them. */
export function resolveCommunicationBasis(
  from: ChatPrincipal,
  to: ChatTarget,
  task: string | null,
  evidence: CommunicationAuthorization | null | undefined,
  lookup: LocalMessageLookup,
): (Omit<CommunicationReceipt, 'rootMessageId'> & { rootMessageId?: string }) | undefined {
  if (evidence == null) return undefined;
  if (evidence.basis === undefined) refuse('communicationAuthorization must name its basis');
  if (evidence.basis === 'user-instruction') return { authorization: evidence, sourceLetter: null };
  const ref = parseLedgerMessageRef(evidence.sourceMessageRef);
  if (ref === null) refuse('Invalid sourceMessageRef: expected <peer thread uuid>#<message uuid>');
  const found = lookup(ref.messageId);
  if (found === null)
    refuse(`sourceMessageRef names message ${ref.messageId}, of which this machine has no record`);
  if (!found.reachedRecipient)
    refuse(
      `Referenced message ${ref.messageId} never reached its recipient — it is still held for delivery, so no correspondence was opened by it`,
    );
  const record = found.message;
  if (record.task !== task)
    refuse(
      'Referenced message belongs to a different task; retain its --task or establish a new basis',
    );
  if (evidence.basis === 'peer-letter') {
    if (chatTargetKey(record.to) !== chatPrincipalKey(from))
      refuse('Referenced message was addressed to a different recipient');
    if (threadOf(record.from) !== ref.threadId)
      refuse('Referenced message was written in a different thread');
    if (chatPrincipalKey(record.from) !== chatTargetKey(to))
      refuse('A peer-letter can only authorize a reply to that exact peer');
    const quote = evidence.userAuthorizationQuote;
    if (quote === undefined || !record.body.includes(quote))
      refuse('The authorization quote is not present verbatim in the referenced peer letter');
    if (record.body.length > 16_384)
      refuse(
        'The source letter exceeds the 16384-character receipt budget; use a bounded authorization letter',
      );
    return {
      authorization: evidence,
      sourceLetter: {
        id: record.id,
        ts: record.ts,
        from: record.from,
        to: record.to,
        task: record.task,
        body: record.body,
      },
    };
  }
  if (chatPrincipalKey(record.from) !== chatPrincipalKey(from))
    refuse('A continuation references your own earlier message');
  if (chatTargetKey(record.to) !== chatTargetKey(to))
    refuse('Referenced message went to a different recipient');
  if (threadOf(to) !== ref.threadId) refuse('The reference names a different recipient thread');
  if (record.communicationAuthorization === undefined)
    refuse('Referenced message carries no authorization');
  // The opening snapshot is carried by every accepted continuation. No growing chain, no replay
  // of a deleted predecessor and no lookup across another host's storage is needed.
  const receipt = record.communicationReceipt;
  if (receipt === undefined)
    refuse('Referenced message has no resolved opening receipt; establish a basis first');
  return receipt;
}
