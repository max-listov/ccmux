import { type FileHandle, lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  type CodexRolloutFile,
  currentRolloutFile,
  parseRolloutName,
  rolloutFile,
  sortRolloutFiles,
} from '../agent/codex/rolloutFiles.ts';
import { fileStamp } from '../util/fileStamp.ts';
import { type ExternalContentTarget, EXTERNAL_CONTENT_LIMITS as limits } from './contentSchema.ts';

const CodexMetaSchema = z.object({
  type: z.literal('session_meta'),
  payload: z.object({ id: z.uuid(), cwd: z.string().startsWith('/').optional() }),
});

export const STORAGE_LOOKUP_MAX_AGE_MS = 5_000;
/**
 * A thread the index does not know is looked for again once the index is this old. A new rollout
 * lands in an existing day directory, which changes neither the root's revision nor any parent the
 * index already follows — without this, a thread started a moment ago read as "no history" for up
 * to the full index age.
 */
export const STORAGE_MISS_RESCAN_MS = 250;
/** The shared walk belongs to no single caller, so it carries its own bound. */
const STORAGE_SCAN_DEADLINE_MS = 10_000;
/** One file of a thread's Codex history (see `agent/codex/rolloutFiles.ts`). */
export type CodexSegment = CodexRolloutFile;
type StorageIndex = {
  segments: Map<string, CodexSegment[] | null>;
  directories: Map<string, string>;
  scannedAt: number;
  expiresAt: number;
};
const indexes = new Map<string, Promise<StorageIndex>>();

/** Wait for shared work on behalf of one caller: its abort ends its own wait, not the work. */
function awaitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** A root-wide index shares a bounded ambiguity check across all threads in the same pass. */
async function codexStorageIndex(root: string, signal: AbortSignal): Promise<StorageIndex> {
  const cached = indexes.get(root);
  if (cached) {
    const index = await awaitFor(cached, signal);
    if (index.expiresAt > Date.now()) return index;
    // A concurrent visitor may already have replaced the expired promise while we awaited it.
    if (indexes.get(root) !== cached) return codexStorageIndex(root, signal);
  }
  if (indexes.size >= 32) indexes.delete(indexes.keys().next().value ?? '');
  // Started under its own deadline: one caller abandoning the lookup must not fail every other
  // caller waiting on the same walk.
  const pending = scanStorage(root, AbortSignal.timeout(STORAGE_SCAN_DEADLINE_MS));
  indexes.set(root, pending);
  void pending.catch(() => {
    if (indexes.get(root) === pending) indexes.delete(root);
  });
  return awaitFor(pending, signal);
}

async function scanStorage(root: string, signal: AbortSignal): Promise<StorageIndex> {
  const segments = new Map<string, CodexSegment[] | null>();
  const directories = new Map<string, string>();
  const seen = new Set<string>();
  await walkStorage(
    root,
    signal,
    (name, path) => {
      const parsed = parseRolloutName(name);
      if (!parsed) return;
      const { thread, segment } = parsed;
      const list = segments.get(thread);
      if (list === null) return;
      // The same thread or segment twice — plain and compressed alike — is not one history.
      const key = `${thread}_${segment ?? ''}`;
      if (seen.has(key)) {
        segments.set(thread, null);
        return;
      }
      seen.add(key);
      segments.set(thread, [...(list ?? []), rolloutFile(path, parsed)]);
    },
    directories,
  );
  for (const list of segments.values()) if (list) sortRolloutFiles(list);
  const scannedAt = Date.now();
  return { segments, directories, scannedAt, expiresAt: scannedAt + STORAGE_LOOKUP_MAX_AGE_MS };
}

/** All files of one Codex thread, oldest first; null when the thread has no history here. */
export async function locateCodexSegments(
  root: string,
  threadId: string,
  signal: AbortSignal,
): Promise<CodexSegment[] | null> {
  let index = await codexStorageIndex(root, signal);
  let list = index.segments.get(threadId);
  const parents = new Set([root, ...(list ? list.map((segment) => dirname(segment.path)) : [])]);
  for (const directory of parents) {
    if (index.directories.get(directory) === directoryRevision(directory)) continue;
    indexes.delete(root);
    index = await codexStorageIndex(root, signal);
    list = index.segments.get(threadId);
    break;
  }
  if (list === undefined && Date.now() - index.scannedAt > STORAGE_MISS_RESCAN_MS) {
    indexes.delete(root);
    index = await codexStorageIndex(root, signal);
    list = index.segments.get(threadId);
  }
  if (list === null) throw new Error('Ambiguous external storage identity');
  // The known parent revision detects removal and atomic replacement. The reader checks the final
  // path, inode/type, permissions and metadata again when opening it.
  return list ?? null;
}

/** Fixed configured roots and UUID filenames only. Never follow a caller path or a symlink. */
export async function locateExternalStorage(
  root: string,
  target: ExternalContentTarget,
  signal: AbortSignal,
) {
  if (target.provider === 'codex') {
    const segments = await locateCodexSegments(root, target.threadId, signal);
    if (segments === null) return null;
    // A split thread is read from the file Codex writes now; the files before it are counted, not
    // stitched. A thread whose every file is compressed has no such file.
    const current = currentRolloutFile(segments);
    if (current === null) throw new Error('External storage is compressed');
    return { path: current.path, earlierFiles: segments.length - 1 };
  }
  let found: string | null = null;
  await walkStorage(root, signal, (name, path) => {
    if (name !== `${target.threadId}.jsonl`) return;
    if (found) throw new Error('Ambiguous external storage identity');
    found = path;
  });
  return found === null ? null : { path: found, earlierFiles: 0 };
}

async function walkStorage(
  root: string,
  signal: AbortSignal,
  visit: (name: string, path: string) => void,
  directories?: Map<string, string>,
) {
  const queue = [{ path: root, depth: 0 }];
  let seen = 0;
  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    signal.throwIfAborted();
    if (!(await lstat(item.path)).isDirectory()) throw new Error('Storage directory changed');
    directories?.set(item.path, directoryRevision(item.path));
    for await (const entry of await opendir(item.path)) {
      signal.throwIfAborted();
      if (++seen > limits.lookupEntries) throw new Error('External lookup budget exceeded');
      if (entry.isSymbolicLink()) continue;
      const path = join(item.path, entry.name);
      if (entry.isDirectory()) {
        if (item.depth >= limits.lookupDepth) throw new Error('External lookup depth exceeded');
        queue.push({ path, depth: item.depth + 1 });
      } else if (entry.isFile()) visit(entry.name, path);
    }
  }
}

/** A directory's own revision: its inode and the clocks a create, delete or rename moves. */
const directoryRevision = (path: string) => fileStamp(path, { follow: false });

export async function validateExternalPath(root: string, path: string) {
  const local = relative(root, path);
  if (local.startsWith(`..${sep}`) || local === '..') throw new Error('Storage containment failed');
  let current = root;
  for (const segment of local.split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Storage symlink refused');
  }
  if ((await realpath(path)) !== path) throw new Error('Storage path changed');
}

async function metadataLines(file: FileHandle) {
  const stat = await file.stat();
  const head = Buffer.alloc(Math.min(limits.metadataBytes, stat.size));
  const { bytesRead } = await file.read(head, 0, head.length, 0);
  const end = head.subarray(0, bytesRead).indexOf(10);
  if (end < 0) throw new Error('External metadata is unpublished or exceeds its byte budget');
  const last = head.subarray(0, bytesRead).lastIndexOf(10);
  return head.toString('utf8', 0, last).split('\n');
}

export async function readExternalCodexMetadata(file: FileHandle, threadId: string) {
  const meta = CodexMetaSchema.safeParse(JSON.parse((await metadataLines(file))[0] ?? ''));
  if (!meta.success || meta.data.payload.id !== threadId)
    throw new Error('External metadata identity differs');
  return meta.data.payload;
}

const ClaudeMetaSchema = z.object({
  sessionId: z.uuid(),
  cwd: z.string().startsWith('/').optional(),
});

export async function readExternalClaudeMetadata(file: FileHandle, threadId: string) {
  for (const line of await metadataLines(file)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const meta = ClaudeMetaSchema.safeParse(value);
    if (!meta.success) continue;
    if (meta.data.sessionId !== threadId) throw new Error('External metadata identity differs');
    return meta.data;
  }
  throw new Error('External metadata is unpublished or exceeds its byte budget');
}
