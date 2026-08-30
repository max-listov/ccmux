import { closeSync, constants, fstatSync, ftruncateSync, readSync } from "node:fs";
import { sameTarget } from "../chat/identity.ts";
import type { ChatPrincipal, ManagedPeer, Session } from "../types.ts";
import { ATTACHMENT_LIMITS } from "./reference.ts";
import type { AttachmentBegin, AttachmentChunk, AttachmentRecord, AttachmentUploadReceipt } from "./schema.ts";
import type { AttachmentTransaction } from "./store.ts";
import { attachmentPath, lstatExists, openPrivate, syncDirectory, writePrivate } from "./files.ts";
import { assertAttachment } from "./errors.ts";
import { ownedAttachment, registration } from "./identity.ts";

export function uploadReceipt(row: AttachmentRecord): AttachmentUploadReceipt {
  return { uploadId: row.id, receivedBytes: row.received, totalBytes: row.bytes,
    expiresAt: new Date(row.expiresAt).toISOString(), phase: row.phase };
}

function ensureUploadFile(tx: AttachmentTransaction, row: AttachmentRecord): void {
  const path = attachmentPath(tx.root, row);
  if (lstatExists(path)) {
    const fd = openPrivate(path, constants.O_RDONLY);
    closeSync(fd);
    return;
  }
  assertAttachment(row.received === 0 && row.phase === "uploading", "attachment-bytes-missing");
  const fd = openPrivate(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
  closeSync(fd);
  syncDirectory(tx.root);
}

function checkQuota(tx: AttachmentTransaction, target: ManagedPeer, bytes: number): void {
  const records = tx.store.records;
  assertAttachment(records.length < ATTACHMENT_LIMITS.records, "attachment-record-quota");
  assertAttachment(records.reduce((sum, row) => sum + row.bytes, 0) + bytes <= ATTACHMENT_LIMITS.hostBytes, "attachment-disk-quota");
  const uploads = records.filter((row) => row.phase === "uploading");
  assertAttachment(uploads.length < ATTACHMENT_LIMITS.hostUploads
    && uploads.filter((row) => sameTarget(row.target, target)).length < ATTACHMENT_LIMITS.targetUploads, "attachment-upload-quota");
}

export function beginUpload(tx: AttachmentTransaction, session: Session, principal: ChatPrincipal,
  input: AttachmentBegin): AttachmentUploadReceipt {
  assertAttachment(!tx.store.cancelled.some((item) => item.id === input.uploadId), "attachment-upload-cancelled");
  const existing = tx.store.records.find((row) => row.id === input.uploadId);
  if (existing) {
    const row = ownedAttachment(tx, session, input.target, principal, input.uploadId);
    assertAttachment(row.mediaType === input.mediaType && row.bytes === input.totalBytes
      && row.digest === input.digest, "upload-idempotency-conflict");
    ensureUploadFile(tx, row);
    return uploadReceipt(row);
  }
  checkQuota(tx, input.target, input.totalBytes);
  const now = Date.now();
  const row: AttachmentRecord = { id: input.uploadId, target: input.target, principal,
    registration: registration(session), mediaType: input.mediaType, bytes: input.totalBytes,
    digest: input.digest, received: 0, phase: "uploading", createdAt: now,
    expiresAt: now + ATTACHMENT_LIMITS.uploadTtlMs, reference: null };
  tx.store.records.push(row);
  // Durable quota reservation precedes file creation; a retry can recover an empty reserved upload.
  tx.persist();
  ensureUploadFile(tx, row);
  return uploadReceipt(row);
}

export function appendUpload(tx: AttachmentTransaction, row: AttachmentRecord,
  input: AttachmentChunk): AttachmentUploadReceipt {
  const data = Buffer.from(input.data, "base64");
  assertAttachment(data.length > 0 && data.length <= ATTACHMENT_LIMITS.chunkBytes
    && data.toString("base64") === input.data, "attachment-chunk-encoding");
  const end = input.offset + data.length;
  assertAttachment(end <= row.bytes && input.offset <= row.received, "attachment-chunk-order");
  ensureUploadFile(tx, row);
  const fd = openPrivate(attachmentPath(tx.root, row), constants.O_RDWR);
  try {
    const size = fstatSync(fd).size;
    assertAttachment(size >= row.received && size <= row.bytes, "attachment-byte-state");
    if (input.offset < row.received) {
      assertAttachment(end <= row.received, "attachment-chunk-overlap");
      const prior = Buffer.alloc(data.length);
      assertAttachment(readSync(fd, prior, 0, prior.length, input.offset) === prior.length && prior.equals(data), "attachment-chunk-conflict");
      return uploadReceipt(row);
    }
    assertAttachment(row.phase === "uploading", "attachment-immutable");
    // A crash after fsync but before the index may leave unacknowledged tail bytes.
    if (size > row.received) ftruncateSync(fd, row.received);
    writePrivate(fd, data, input.offset);
    row.received = end;
    tx.persist();
    return uploadReceipt(row);
  } finally { closeSync(fd); }
}
