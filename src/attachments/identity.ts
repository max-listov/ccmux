import { samePrincipal, sameTarget } from '../chat/identity.ts';
import { controlTarget } from '../control/target.ts';
import type { ChatPrincipal, MachineConfig, ManagedPeer, Session } from '../types.ts';
import { assertAttachment } from './errors.ts';
import type { AttachmentReference } from './reference.ts';
import type { AttachmentRecord } from './schema.ts';
import type { AttachmentTransaction } from './store.ts';

export function attachmentSession(m: MachineConfig, target: ManagedPeer, write: boolean): Session {
  const session = controlTarget(m, target);
  assertAttachment(
    (session.agent === 'codex' && session.runtime === 'app-server') ||
      (session.agent === 'opencode' && session.runtime === 'native'),
    'unsupported-runtime',
  );
  assertAttachment(session.registrationGeneration !== undefined, 'registration-required');
  assertAttachment(!write || !session.archived, 'archived-target');
  return session;
}

export function registration(session: Session): string {
  assertAttachment(session.registrationGeneration !== undefined, 'registration-required');
  return session.registrationGeneration;
}

export function ownedAttachment(
  tx: AttachmentTransaction,
  session: Session,
  target: ManagedPeer,
  principal: ChatPrincipal,
  id: string,
): AttachmentRecord {
  const row = tx.store.records.find((item) => item.id === id);
  assertAttachment(
    row !== undefined &&
      row.registration === registration(session) &&
      sameTarget(row.target, target) &&
      samePrincipal(row.principal, principal),
    'attachment-scope',
  );
  return row;
}

export function sameReferences(left: AttachmentReference[], right: AttachmentReference[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const item = right[index];
      return item !== undefined && sameReference(value, item);
    })
  );
}

export function sameReference(left: AttachmentReference, right: AttachmentReference): boolean {
  return (
    left.id === right.id &&
    left.digest === right.digest &&
    left.mediaType === right.mediaType &&
    left.bytes === right.bytes &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function verifiedReference(
  row: AttachmentRecord,
  reference?: AttachmentReference,
): AttachmentReference {
  assertAttachment(row.phase !== 'uploading' && row.reference !== null, 'attachment-incomplete');
  assertAttachment(
    reference === undefined || sameReference(row.reference, reference),
    'attachment-reference-changed',
  );
  return row.reference;
}

export function readableAttachment(
  tx: AttachmentTransaction,
  session: Session,
  target: ManagedPeer,
  principal: ChatPrincipal,
  reference: AttachmentReference,
): AttachmentRecord {
  const row = tx.store.records.find((item) => item.id === reference.id);
  assertAttachment(row !== undefined, 'attachment-scope');
  const direct =
    row.registration === registration(session) &&
    sameTarget(row.target, target) &&
    samePrincipal(row.principal, principal);
  const inherited = tx.store.pins.some(
    (pin) =>
      pin.registration === registration(session) &&
      sameTarget(pin.target, target) &&
      samePrincipal(pin.principal, principal) &&
      pin.references.some((item) => sameReference(item, reference)),
  );
  assertAttachment(direct || inherited, 'attachment-scope');
  verifiedReference(row, reference);
  return row;
}
