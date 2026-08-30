import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import { lstatExists, readPrivate, writePrivateJson } from '../attachments/files.ts';
import { managedRuntimeRoot } from '../runtime/status.ts';
import type { ChatPrincipal, MachineConfig, Session } from '../types.ts';
import { chatPrincipalKey } from './identity.ts';
import {
  MESSAGE_OPERATION_LIMITS,
  type MessageOperationJournal,
  MessageOperationJournalSchema,
  type MessageOperationRecord,
} from './messageOperationSchema.ts';

export function messageOperationFailure(): never {
  throw new AppError('MESSAGE_EVIDENCE_UNAVAILABLE', 'Message evidence is unavailable', 503);
}
export function messagePrincipal(principal: ChatPrincipal): string {
  return createHash('sha256').update(chatPrincipalKey(principal)).digest('hex');
}
export function readMessageJournal(m: MachineConfig, s: Session): MessageOperationJournal | null {
  const path = join(managedRuntimeRoot(m, s), 'message-receipts.json');
  if (!lstatExists(path)) return null;
  const journal = MessageOperationJournalSchema.parse(
    JSON.parse(readPrivate(path, MESSAGE_OPERATION_LIMITS.bytes).toString()),
  );
  const nativeId = s.agent === 'codex' ? s.uuid : s.nativeSession?.id;
  if (
    journal.registrationGeneration !== s.registrationGeneration ||
    journal.nativeSession.runtime !== s.agent ||
    journal.nativeSession.id !== nativeId
  )
    return messageOperationFailure();
  return journal;
}
function write(m: MachineConfig, s: Session, journal: MessageOperationJournal): void {
  const value = MessageOperationJournalSchema.parse(journal);
  if (Buffer.byteLength(JSON.stringify(value)) > MESSAGE_OPERATION_LIMITS.bytes)
    messageOperationFailure();
  const root = managedRuntimeRoot(m, s);
  privateRuntimeDirectory(root);
  writePrivateJson(root, 'message-receipts.json', value);
}

/** The existing native admission lock owns every transition; readers never repair or dispatch. */
export function prepareMessageOperation(
  m: MachineConfig,
  s: Session,
  from: ChatPrincipal,
  messageId: string,
  fingerprint: string,
  now = Date.now(),
): void {
  const journal =
    readMessageJournal(m, s) ??
    MessageOperationJournalSchema.parse({
      registrationGeneration: s.registrationGeneration,
      nativeSession: { runtime: s.agent, id: s.agent === 'codex' ? s.uuid : s.nativeSession?.id },
      records: [],
    });
  const prior = journal.records.find((record) => record.messageId === messageId);
  if (prior) {
    if (prior.principal !== messagePrincipal(from) || prior.fingerprint !== fingerprint)
      messageOperationFailure();
    return;
  }
  journal.records = journal.records.filter(
    (record) => record.expiresAt === null || Date.parse(record.expiresAt) > now,
  );
  if (journal.records.length >= MESSAGE_OPERATION_LIMITS.records) {
    const index = journal.records.findIndex((record) => record.expiresAt !== null);
    if (index < 0) throw new AppError('CAPACITY', 'Message evidence capacity reached', 429);
    journal.records.splice(index, 1);
  }
  journal.records.push({
    messageId,
    principal: messagePrincipal(from),
    fingerprint,
    phase: 'preparing',
    turnId: null,
    observedAt: new Date(now).toISOString(),
    expiresAt: null,
  });
  write(m, s, journal);
}

export function advanceMessageOperation(
  m: MachineConfig,
  s: Session,
  messageId: string,
  phase: MessageOperationRecord['phase'],
  turnId: string | null = null,
  now = Date.now(),
): void {
  const journal = readMessageJournal(m, s);
  const record = journal?.records.find((item) => item.messageId === messageId);
  // Messages admitted before receipt retention (and peer/CLI messages) have no public binding.
  if (!journal || !record) return;
  if (record.turnId !== null && turnId !== null && record.turnId !== turnId)
    messageOperationFailure();
  if (
    turnId !== null &&
    journal.records.some((item) => item.messageId !== messageId && item.turnId === turnId)
  )
    messageOperationFailure();
  if (record.expiresAt !== null) return;
  if (phase === 'queued' && record.phase !== 'preparing') return;
  if (phase === 'uncertain' && record.turnId !== null) return;
  if (phase === 'admitted' && turnId === null) messageOperationFailure();
  const terminal = phase === 'completed' || phase === 'interrupted' || phase === 'failed';
  if (terminal && turnId === null) messageOperationFailure();
  if (record.phase === phase && (turnId === null || record.turnId === turnId)) return;
  record.phase = phase;
  record.turnId = turnId ?? record.turnId;
  record.observedAt = new Date(now).toISOString();
  record.expiresAt = terminal
    ? new Date(now + MESSAGE_OPERATION_LIMITS.terminalTtlMs).toISOString()
    : null;
  write(m, s, journal);
}
