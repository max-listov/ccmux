import { AppError } from 'stitchkit';
import type { ChatMessage } from '../types.ts';
import type { CommunicationAuthorization } from './communicationAuthorizationSchema.ts';
import { parseLedgerMessageRef } from './communicationAuthorizationSchema.ts';
import type { CommunicationReceipt } from './communicationReceiptSchema.ts';
import { chatPrincipalKey, chatTargetKey } from './identity.ts';
import type { ChatPrincipal, ChatTarget } from './identitySchema.ts';

export type LocalMessageLookup = (id: string) => ChatMessage | null;

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
  const record = lookup(ref.messageId);
  if (record === null)
    refuse(`sourceMessageRef names message ${ref.messageId}, of which this machine has no record`);
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
