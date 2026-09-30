import { type FileHandle, lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { type ExternalContentTarget, EXTERNAL_CONTENT_LIMITS as limits } from './contentSchema.ts';

const CodexMetaSchema = z.object({
  type: z.literal('session_meta'),
  payload: z.object({ id: z.uuid(), cwd: z.string().startsWith('/').optional() }),
});

export const STORAGE_LOOKUP_MAX_AGE_MS = 5_000;
type StorageIndex = {
  paths: Map<string, string | null>;
  directories: Map<string, string>;
  expiresAt: number;
};
const indexes = new Map<string, Promise<StorageIndex>>();

/** A root-wide index shares a bounded ambiguity check across all threads in the same pass. */
async function codexStorageIndex(root: string, signal: AbortSignal): Promise<StorageIndex> {
  const cached = indexes.get(root);
  if (cached) {
    const index = await cached;
    signal.throwIfAborted();
    if (index.expiresAt > Date.now()) return index;
    // A concurrent visitor may already have replaced the expired promise while we awaited it.
    if (indexes.get(root) !== cached) return codexStorageIndex(root, signal);
  }
  if (indexes.size >= 32) indexes.delete(indexes.keys().next().value ?? '');
  const pending = scanStorage(root, signal);
  indexes.set(root, pending);
  try {
    return await pending;
  } catch (error) {
    if (indexes.get(root) === pending) indexes.delete(root);
    throw error;
  }
}

async function scanStorage(root: string, signal: AbortSignal): Promise<StorageIndex> {
  const paths = new Map<string, string | null>();
  const directories = new Map<string, string>();
  await walkStorage(
    root,
    signal,
    (name, path) => {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) return;
      const id = name.slice(-42, -6);
      if (!z.uuid().safeParse(id).success) return;
      paths.set(id, paths.has(id) ? null : path);
    },
    directories,
  );
  return { paths, directories, expiresAt: Date.now() + STORAGE_LOOKUP_MAX_AGE_MS };
}

/** Fixed configured roots and UUID filenames only. Never follow a caller path or a symlink. */
export async function locateExternalStorage(
  root: string,
  target: ExternalContentTarget,
  signal: AbortSignal,
) {
  if (target.provider === 'codex') {
    let index = await codexStorageIndex(root, signal);
    let path = index.paths.get(target.threadId);
    const parents = new Set([root, ...(typeof path === 'string' ? [dirname(path)] : [])]);
    for (const directory of parents) {
      if (index.directories.get(directory) === (await directoryRevision(directory))) continue;
      indexes.delete(root);
      index = await codexStorageIndex(root, signal);
      path = index.paths.get(target.threadId);
      break;
    }
    if (path === null) throw new Error('Ambiguous external storage identity');
    if (path === undefined) return null;
    // The known parent revision detects removal and atomic replacement. The reader checks
    // the final path, inode/type, permissions and metadata again when opening it; repeating
    // lstat here would add an async IO round trip without another authorization guarantee.
    return path;
  }
  let found: string | null = null;
  await walkStorage(root, signal, (name, path) => {
    if (name !== `${target.threadId}.jsonl`) return;
    if (found) throw new Error('Ambiguous external storage identity');
    found = path;
  });
  return found;
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
    directories?.set(item.path, await directoryRevision(item.path));
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

async function directoryRevision(path: string): Promise<string> {
  try {
    const stat = await lstat(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

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
