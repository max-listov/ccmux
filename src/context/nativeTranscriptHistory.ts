import type { NativeHistoryEntry, NativeHistoryPage } from './schema.ts';

/** Absolute positions require the origin of the conversation, never a sliding suffix. */
const MAX_ENTRIES = 65_536;
const MAX_BYTES = 32 * 1024 * 1024;

export async function completeNativeHistory(
  read: (cursor?: string) => Promise<NativeHistoryPage>,
  signal: AbortSignal,
): Promise<NativeHistoryEntry[]> {
  const pages: NativeHistoryEntry[][] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  let identity: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = await read(cursor);
    signal.throwIfAborted();
    const currentIdentity = JSON.stringify([page.runtime, page.nativeId, page.revision]);
    identity ??= currentIdentity;
    if (identity !== currentIdentity) throw new Error('native history identity changed');
    if (page.omittedItems !== 0 || page.completeness === 'unknown')
      throw new Error('native history is incomplete');
    bytes += Buffer.byteLength(JSON.stringify(page.entries));
    if (bytes > MAX_BYTES || ids.size + page.entries.length > MAX_ENTRIES)
      throw new Error('native history exceeds transcript budget');
    for (const entry of page.entries) {
      if (ids.has(entry.itemId)) throw new Error('native history repeats an entry');
      ids.add(entry.itemId);
    }
    pages.push(page.entries);
    if (page.completeness === 'complete') {
      if (page.nextCursor !== null) throw new Error('native history has contradictory bounds');
      return pages.reverse().flat();
    }
    if (page.nextCursor === null || cursors.has(page.nextCursor))
      throw new Error('native history cursor does not advance');
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
