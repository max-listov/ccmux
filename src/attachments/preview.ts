import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, readSync } from 'node:fs';
import { assertAttachment } from './errors.ts';
import { openPrivate } from './files.ts';
import { ATTACHMENT_LIMITS, type AttachmentReference } from './reference.ts';

const verified = new Map<string, { stamp: string; digest: string }>();
const MAX_VERIFIED_FILES = 64;

function stamp(fd: number): string {
  const info = fstatSync(fd, { bigint: true });
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function exactRead(fd: number, offset: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, bytes, read, length - read, offset + read);
    assertAttachment(count > 0, 'attachment-short-read');
    read += count;
  }
  return bytes;
}

/** Hash once per immutable inode state, then serve bounded ranges without rescanning the image. */
export function previewBytes(path: string, reference: AttachmentReference, offset: number): Buffer {
  const fd = openPrivate(path, constants.O_RDONLY);
  try {
    const before = stamp(fd);
    assertAttachment(
      fstatSync(fd).size === reference.bytes && offset <= reference.bytes,
      'attachment-preview-size',
    );
    const cached = verified.get(path);
    if (cached?.stamp !== before || cached.digest !== reference.digest) {
      const digest = createHash('sha256');
      for (let position = 0; position < reference.bytes; position += ATTACHMENT_LIMITS.chunkBytes) {
        digest.update(
          exactRead(
            fd,
            position,
            Math.min(ATTACHMENT_LIMITS.chunkBytes, reference.bytes - position),
          ),
        );
      }
      assertAttachment(
        digest.digest('hex') === reference.digest && before === stamp(fd),
        'attachment-digest',
      );
      verified.delete(path);
      if (verified.size >= MAX_VERIFIED_FILES) {
        const oldest = verified.keys().next();
        if (!oldest.done) verified.delete(oldest.value);
      }
      verified.set(path, { stamp: before, digest: reference.digest });
    }
    const bytes = exactRead(
      fd,
      offset,
      Math.min(ATTACHMENT_LIMITS.chunkBytes, reference.bytes - offset),
    );
    assertAttachment(before === stamp(fd), 'attachment-preview-changed');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
