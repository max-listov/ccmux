import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { AppError } from 'stitchkit';
import { projectContent } from './contentProjection.ts';
import {
  type ExternalContentEntry,
  type ExternalContentTarget,
  EXTERNAL_CONTENT_LIMITS as limits,
} from './contentSchema.ts';

export interface ContentSnapshot {
  id: string;
  identity: string;
  fileIdentity: string;
  revision: string;
  size: number;
  stamp: string;
  expires: number;
  entries: ExternalContentEntry[];
  omitted: number;
  memory: number;
}

const snapshots = new Map<string, ContentSnapshot>();
let retainedBytes = 0;
let building = 0;
let scanning = 0;
export const fileIdentity = (stat: Stats, path: string) =>
  JSON.stringify([path, stat.dev, stat.ino]);
export const contentStamp = (stat: Stats) =>
  JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs]);

function prune() {
  for (const [id, value] of snapshots)
    if (value.expires <= Date.now()) {
      snapshots.delete(id);
      retainedBytes -= value.memory;
    }
}

export function getContentSnapshot(id: string): ContentSnapshot | undefined {
  prune();
  return snapshots.get(id);
}

export function findContentSnapshot(identity: string, stat: Stats, path: string) {
  prune();
  return [...snapshots.values()].find(
    (value) =>
      value.identity === identity &&
      value.fileIdentity === fileIdentity(stat, path) &&
      value.size === stat.size &&
      value.stamp === contentStamp(stat),
  );
}

function retain(value: ContentSnapshot) {
  prune();
  if (snapshots.has(value.id)) return;
  while (snapshots.size >= limits.snapshots || retainedBytes + value.memory > limits.cacheBytes) {
    const first = snapshots.values().next().value;
    if (!first) break;
    snapshots.delete(first.id);
    retainedBytes -= first.memory;
  }
  snapshots.set(value.id, value);
  retainedBytes += value.memory;
}

/** The fixed prefix is hashed, never the newly appended tail. Memory stays one chunk. */
async function scan(
  file: FileHandle,
  size: number,
  signal: AbortSignal,
  consume?: (chunk: Buffer, offset: number) => void,
) {
  if (scanning >= limits.concurrentBuilds)
    throw new AppError('RESOURCE_EXHAUSTED', 'External history reader capacity is busy', 429);
  scanning++;
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(limits.chunkBytes);
    for (let offset = 0; offset < size; ) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (!bytesRead) return null;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      consume?.(chunk, offset);
      offset += bytesRead;
    }
    signal.throwIfAborted();
    return hash.digest('hex');
  } finally {
    scanning--;
  }
}

/** A retained projection owns its text, never pointers into a mutable provider buffer. */
export async function buildContentSnapshot(
  file: FileHandle,
  stat: Stats,
  path: string,
  identity: string,
  target: ExternalContentTarget,
  signal: AbortSignal,
) {
  if (stat.size > limits.sourceBytes)
    throw new AppError(
      'RESOURCE_EXHAUSTED',
      'External history source exceeds the snapshot budget',
      413,
    );
  if (building >= limits.concurrentBuilds)
    throw new AppError('RESOURCE_EXHAUSTED', 'External history snapshot capacity is busy', 429);
  building++;
  try {
    const entries: ExternalContentEntry[] = [];
    let pending = Buffer.alloc(0),
      skipping = false,
      rowStart = 0,
      omitted = 0,
      memory = 0;
    const revision = await scan(file, stat.size, signal, (chunk, offset) => {
      for (let position = 0; position < chunk.length; ) {
        const newline = chunk.indexOf(10, position);
        const end = newline < 0 ? chunk.length : newline;
        if (!skipping) {
          if (pending.length + end - position > limits.recordBytes) {
            pending = Buffer.alloc(0);
            skipping = true;
          } else pending = Buffer.concat([pending, chunk.subarray(position, end)]);
        }
        if (newline < 0) break;
        const entry = skipping ? null : projectContent(pending.toString('utf8'), target, rowStart);
        if (entry) {
          memory += entry.text.length * 2 + 256;
          if (memory > limits.snapshotBytes)
            throw new AppError(
              'RESOURCE_EXHAUSTED',
              'External history projection exceeds the snapshot budget',
              413,
            );
          entries.push(entry);
        } else omitted++;
        pending = Buffer.alloc(0);
        skipping = false;
        position = newline + 1;
        rowStart = offset + position;
      }
    });
    if (pending.length || skipping) omitted++;
    if (revision === null) return null;
    const snapshot: ContentSnapshot = {
      id: randomUUID(),
      identity,
      fileIdentity: fileIdentity(stat, path),
      size: stat.size,
      stamp: contentStamp(stat),
      revision,
      expires: Date.now() + limits.snapshotTtlMs,
      entries,
      omitted,
      memory,
    };
    return snapshot;
  } finally {
    building--;
  }
}

/** Stat is only a fast path. A changed source must prove its entire pinned prefix. */
export async function validateContentSnapshot(
  snapshot: ContentSnapshot,
  file: FileHandle,
  path: string,
  signal: AbortSignal,
) {
  const before = await file.stat();
  if (fileIdentity(before, path) !== snapshot.fileIdentity || before.size < snapshot.size)
    return false;
  if (contentStamp(before) === snapshot.stamp) return true;
  if ((await scan(file, snapshot.size, signal)) !== snapshot.revision) return false;
  const after = await file.stat();
  if (fileIdentity(after, path) !== snapshot.fileIdentity || after.size < snapshot.size)
    return false;
  // Concurrent changes cannot be cached as validated. The immutable projection still cannot mix generations.
  if (contentStamp(before) === contentStamp(after)) snapshot.stamp = contentStamp(after);
  return true;
}

export function publishContentSnapshot(snapshot: ContentSnapshot) {
  retain(snapshot);
}
