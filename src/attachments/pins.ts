import { createHash } from 'node:crypto';
import { managedPeer, samePrincipal, sameTarget } from '../chat/identity.ts';
import type { ChatPrincipal, MachineConfig, ManagedPeer, Session } from '../types.ts';
import { assertAttachment } from './errors.ts';
import { attachmentPath, readPrivate } from './files.ts';
import {
  attachmentSession,
  readableAttachment,
  registration,
  sameReferences,
  verifiedReference,
} from './identity.ts';
import {
  ATTACHMENT_LIMITS,
  type AttachmentReference,
  AttachmentReferencesSchema,
} from './reference.ts';
import type { AttachmentRecord } from './schema.ts';
import { type AttachmentTransaction, withAttachmentStore } from './store.ts';

function exactBytes(
  tx: AttachmentTransaction,
  row: AttachmentRecord,
  reference: AttachmentReference,
): Buffer {
  const bytes = readPrivate(attachmentPath(tx.root, row), ATTACHMENT_LIMITS.imageBytes);
  assertAttachment(
    bytes.length === reference.bytes &&
      createHash('sha256').update(bytes).digest('hex') === reference.digest,
    'attachment-digest',
  );
  return bytes;
}

/** Caller already holds the session-registry lock. Pins survive an uncertain ledger callback. */
export async function withPinnedAttachments<T>(
  m: MachineConfig,
  principal: ChatPrincipal,
  target: ManagedPeer,
  messageId: string,
  references: AttachmentReference[],
  accept: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const parsed = AttachmentReferencesSchema.parse(references);
  return withAttachmentStore(
    m,
    'pin',
    async (tx) => {
      const session = attachmentSession(m, target, true);
      const prior = tx.store.pins.find(
        (pin) => pin.messageId === messageId && sameTarget(pin.target, target),
      );
      if (prior) {
        assertAttachment(
          prior.registration === registration(session) &&
            samePrincipal(prior.principal, principal) &&
            sameReferences(prior.references, parsed),
          'attachment-pin-conflict',
        );
      } else {
        assertAttachment(tx.store.pins.length < ATTACHMENT_LIMITS.pins, 'attachment-pin-quota');
        const rows = parsed.map((ref) => readableAttachment(tx, session, target, principal, ref));
        for (const [index, row] of rows.entries()) {
          const ref = parsed[index];
          assertAttachment(ref !== undefined, 'attachment-reference-index');
          exactBytes(tx, row, ref);
          row.phase = 'retained';
        }
        tx.store.pins.push({
          messageId,
          target,
          principal,
          registration: registration(session),
          references: parsed,
        });
        tx.persist();
      }
      signal.throwIfAborted();
      return accept();
    },
    signal,
  );
}

export type NativeAttachment = {
  reference: AttachmentReference;
  path: string;
  dataUrl: string | null;
};

/** Owner-only provider input; private paths and data URLs must never enter receipts or status. */
export async function resolveMessageAttachments(
  m: MachineConfig,
  session: Session,
  messageId: string,
  references: AttachmentReference[],
  signal: AbortSignal,
  format: 'path' | 'data-url' = 'path',
): Promise<NativeAttachment[]> {
  const parsed = AttachmentReferencesSchema.parse(references);
  if (parsed.length === 0) return [];
  return withAttachmentStore(
    m,
    'resolve',
    async (tx) => {
      const target = managedPeer(m.rcPrefix, session);
      const current = attachmentSession(m, target, true);
      const pin = tx.store.pins.find(
        (entry) =>
          entry.messageId === messageId &&
          entry.registration === registration(current) &&
          sameTarget(entry.target, target),
      );
      assertAttachment(
        pin !== undefined && sameReferences(pin.references, parsed),
        'attachment-pin-required',
      );
      return parsed.map((reference) => {
        const row = readableAttachment(tx, current, target, pin.principal, reference);
        assertAttachment(row.phase === 'retained', 'attachment-not-retained');
        const bytes = exactBytes(tx, row, reference);
        return {
          reference,
          path: attachmentPath(tx.root, row),
          dataUrl:
            format === 'data-url'
              ? `data:${reference.mediaType};base64,${bytes.toString('base64')}`
              : null,
        };
      });
    },
    signal,
  );
}

/** Native history stays provider-owned; a fork only extends the reachability of existing assets. */
export async function inheritAttachmentPins(
  m: MachineConfig,
  source: Session,
  destination: Session,
  signal: AbortSignal,
): Promise<void> {
  return withAttachmentStore(
    m,
    'fork-retention',
    async (tx) => {
      const sourceTarget = managedPeer(m.rcPrefix, source),
        destinationTarget = managedPeer(m.rcPrefix, destination);
      const currentSource = attachmentSession(m, sourceTarget, false);
      const currentDestination = attachmentSession(m, destinationTarget, false);
      const original = tx.store.pins.filter(
        (pin) =>
          pin.registration === registration(currentSource) && sameTarget(pin.target, sourceTarget),
      );
      for (const pin of original) {
        const existing = tx.store.pins.find(
          (item) => item.messageId === pin.messageId && sameTarget(item.target, destinationTarget),
        );
        if (existing) {
          assertAttachment(
            existing.registration === registration(currentDestination) &&
              samePrincipal(existing.principal, pin.principal) &&
              sameReferences(existing.references, pin.references),
            'fork-pin-conflict',
          );
          continue;
        }
        assertAttachment(tx.store.pins.length < ATTACHMENT_LIMITS.pins, 'attachment-pin-quota');
        for (const ref of pin.references) {
          const row = readableAttachment(tx, currentSource, sourceTarget, pin.principal, ref);
          verifiedReference(row, ref);
          assertAttachment(row.phase === 'retained', 'fork-pin-not-retained');
        }
        tx.store.pins.push({
          ...pin,
          target: destinationTarget,
          registration: registration(currentDestination),
        });
      }
      signal.throwIfAborted();
      tx.persist();
    },
    signal,
  );
}
