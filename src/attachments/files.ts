import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { MachineConfig } from '../types.ts';
import { assertAttachment } from './errors.ts';
import type { AttachmentRecord } from './schema.ts';

export function attachmentRoot(m: MachineConfig): string {
  const state = lstatSync(m.stateDir);
  assertAttachment(state.isDirectory() && !state.isSymbolicLink(), 'state-root-type');
  const root = join(m.stateDir, 'attachments');
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const info = lstatSync(root);
  assertAttachment(
    info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0,
    'store-root-type',
  );
  return root;
}

export function attachmentPath(
  root: string,
  record: Pick<AttachmentRecord, 'id' | 'mediaType'>,
): string {
  return join(root, `${record.id}.${record.mediaType === 'image/png' ? 'png' : 'jpg'}`);
}

export function openPrivate(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd);
    assertAttachment(
      info.isFile() &&
        info.nlink === 1 &&
        (info.mode & 0o077) === 0 &&
        (process.getuid === undefined || info.uid === process.getuid()),
      'private-file-type',
    );
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function checkPrivateLock(path: string): void {
  if (!lstatExists(path)) return;
  const info = lstatSync(path);
  assertAttachment(
    info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0,
    'private-lock-type',
  );
}

export function readPrivate(path: string, maxBytes: number): Buffer {
  const fd = openPrivate(path, constants.O_RDONLY);
  try {
    const size = fstatSync(fd).size;
    assertAttachment(size <= maxBytes, 'private-file-limit');
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      assertAttachment(read > 0, 'private-file-short-read');
      offset += read;
    }
    assertAttachment(fstatSync(fd).size === size, 'private-file-changed');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function writePrivate(fd: number, data: Uint8Array, position: number): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset, position + offset);
    assertAttachment(written > 0, 'private-file-short-write');
    offset += written;
  }
  fsyncSync(fd);
}

export function syncDirectory(root: string): void {
  const fd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writePrivateJson(root: string, name: string, value: unknown): void {
  const path = join(root, name);
  if (existsSync(path) || lstatExists(path)) {
    const fd = openPrivate(path, constants.O_RDONLY);
    closeSync(fd);
  }
  const temporary = join(root, `${name}.${crypto.randomUUID()}.tmp`);
  const fd = openPrivate(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    writePrivate(fd, Buffer.from(JSON.stringify(value)), 0);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(root);
}

export function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export function removePrivate(path: string): void {
  if (!lstatExists(path)) return;
  const fd = openPrivate(path, constants.O_RDONLY);
  closeSync(fd);
  unlinkSync(path);
}
