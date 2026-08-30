import { type FSWatcher, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { AppError } from 'stitchkit';
import { type BoundedChannel, createBoundedChannel } from 'stitchkit/application';
import { ownedCodexStatusPath } from '../agent/codex/ownedPaths.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import { readPrivateJson } from '../runtime/store.ts';
import type { MachineConfig, Session } from '../types.ts';
import {
  CONTENT_FILE_MAX_BYTES,
  CONTENT_MAX_READERS,
  type ContentCursor,
  type ContentRead,
  type ContentSnapshot,
  ContentSnapshotSchema,
} from './schema.ts';
import { contentPath } from './store.ts';

export function contentFrame(snapshot: ContentSnapshot, cursor: ContentCursor | null): ContentRead {
  const { droppedThrough, contextBoundary, ...frame } = snapshot;
  const reset =
    cursor === null
      ? 'initial'
      : cursor.generation !== snapshot.generation
        ? 'generation'
        : cursor.sequence < contextBoundary
          ? 'context'
          : cursor.sequence < droppedThrough || cursor.sequence > snapshot.sequence
            ? 'gap'
            : null;
  return {
    ...frame,
    reset,
    records:
      reset === null
        ? snapshot.records.filter((item) => item.sequence > (cursor?.sequence ?? 0))
        : [],
    baseline: reset === null ? [] : snapshot.baseline,
  };
}

export function readContent(
  m: MachineConfig,
  session: Session,
  cursor: ContentCursor | null = null,
): ContentRead {
  const snapshot = readPrivateJson(
    contentPath(m, session),
    ContentSnapshotSchema,
    CONTENT_FILE_MAX_BYTES,
  );
  if (
    snapshot === null ||
    snapshot.target.machine !== m.rcPrefix ||
    snapshot.target.session !== session.name ||
    snapshot.target.threadId !== session.uuid ||
    snapshot.target.agent !== session.agent ||
    snapshot.registrationGeneration !== (session.registrationGeneration ?? null) ||
    snapshot.nativeId !== (session.nativeSession?.id ?? session.uuid)
  )
    throw new AppError('UNAVAILABLE', 'Native content is unavailable', 503);
  const runtime = readManagedRuntimeStatus(m, session);
  const live = runtime.status === 'live' && runtime.snapshot?.generation === snapshot.generation;
  const frame = contentFrame(snapshot, cursor);
  return live ? frame : { ...frame, status: 'unavailable', records: [], baseline: [] };
}

type WatchGroup = {
  watchers: FSWatcher[];
  readers: Set<BoundedChannel<number>>;
  expiry: ReturnType<typeof setInterval>;
};
const groups = new Map<string, WatchGroup>();
let readers = 0;

/** Notifications and a shared lease-expiry check retain notices, never queued content copies. */
export async function* subscribeContent(
  m: MachineConfig,
  session: Session,
  cursor: ContentCursor | null,
  signal: AbortSignal,
): AsyncIterable<ContentRead> {
  signal.throwIfAborted();
  if (readers >= CONTENT_MAX_READERS)
    throw new AppError('BUSY', 'Native content subscriber limit reached', 429);
  const path = contentPath(m, session);
  let group = groups.get(path);
  if (group === undefined) {
    const peers = new Set<BoundedChannel<number>>();
    const notify = () => {
      for (const peer of peers) peer.offer(1);
    };
    const watchers: FSWatcher[] = [];
    try {
      watchers.push(
        watch(dirname(path), (_event, file) => {
          const name = file === null ? null : basename(String(file));
          if (
            name === null ||
            name === basename(path) ||
            name.startsWith(`${basename(path)}.notice`) ||
            name.startsWith('status.json') ||
            name.startsWith('selection.json')
          )
            notify();
        }),
      );
      watchers.push(watch(`${path}.notice`, notify));
      if (session.agent === 'codex') {
        const statusPath = ownedCodexStatusPath(m, session.name);
        watchers.push(
          watch(dirname(statusPath), (_event, file) => {
            if (file === null || basename(String(file)).startsWith(basename(statusPath))) notify();
          }),
        );
      }
    } catch {
      for (const watcher of watchers) watcher.close();
      throw new AppError('UNAVAILABLE', 'Native content notifications unavailable', 503);
    }
    group = { watchers, readers: peers, expiry: setInterval(notify, 1_000) };
    groups.set(path, group);
    for (const active of watchers)
      active.on('error', () => {
        for (const peer of peers) peer.fail(new Error('Native content notifications unavailable'));
      });
  }
  const channel = createBoundedChannel<number>({
    policy: 'latest',
    maxItems: 1,
    maxBytes: 8,
    sizeOf: () => 8,
    signal,
  });
  group.readers.add(channel);
  readers++;
  channel.offer(1);
  let next = cursor;
  try {
    for await (const _notice of channel) {
      const frame = readContent(m, session, next);
      // Prepared native lease/settings can change without a content sequence. The public
      // projection deduplicates the combined frame after adding that metadata.
      yield frame;
      if (frame.status === 'live')
        next = { generation: frame.generation, sequence: frame.sequence };
    }
  } finally {
    channel.close({ mode: 'discard' });
    group.readers.delete(channel);
    readers--;
    if (group.readers.size === 0) {
      clearInterval(group.expiry);
      for (const watcher of group.watchers) watcher.close();
      groups.delete(path);
    }
  }
}
