import { type FileHandle, lstat, opendir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { type ExternalContentTarget, EXTERNAL_CONTENT_LIMITS as limits } from './contentSchema.ts';

const CodexMetaSchema = z.object({
  type: z.literal('session_meta'),
  payload: z.object({ id: z.uuid(), cwd: z.string().startsWith('/').optional() }),
});

/** Fixed configured roots and UUID filenames only. Never follow a caller path or a symlink. */
export async function locateExternalStorage(
  root: string,
  target: ExternalContentTarget,
  signal: AbortSignal,
) {
  const queue = [{ path: root, depth: 0 }];
  let seen = 0;
  let found: string | null = null;
  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    signal.throwIfAborted();
    if (!(await lstat(item.path)).isDirectory()) throw new Error('Storage directory changed');
    for await (const entry of await opendir(item.path)) {
      signal.throwIfAborted();
      if (++seen > limits.lookupEntries) throw new Error('External lookup budget exceeded');
      if (entry.isSymbolicLink()) continue;
      const path = join(item.path, entry.name);
      if (entry.isDirectory()) {
        if (item.depth >= limits.lookupDepth) throw new Error('External lookup depth exceeded');
        queue.push({ path, depth: item.depth + 1 });
      } else if (
        entry.isFile() &&
        (target.provider === 'codex'
          ? entry.name.startsWith('rollout-') && entry.name.endsWith(`-${target.threadId}.jsonl`)
          : entry.name === `${target.threadId}.jsonl`)
      ) {
        if (found) throw new Error('Ambiguous external storage identity');
        found = path;
      }
    }
  }
  return found;
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

export async function readExternalCodexMetadata(file: FileHandle, threadId: string) {
  const stat = await file.stat();
  const head = Buffer.alloc(Math.min(limits.metadataBytes, stat.size));
  const { bytesRead } = await file.read(head, 0, head.length, 0);
  const end = head.subarray(0, bytesRead).indexOf(10);
  if (end < 0) throw new Error('External metadata is unpublished or exceeds its byte budget');
  const meta = CodexMetaSchema.safeParse(JSON.parse(head.toString('utf8', 0, end)));
  if (!meta.success || meta.data.payload.id !== threadId)
    throw new Error('External metadata identity differs');
  return meta.data.payload;
}
