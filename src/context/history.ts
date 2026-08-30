import { AppError } from 'stitchkit';
import { z } from 'zod';
import { attachmentPath } from '../attachments/files.ts';
import type { AttachmentReference } from '../attachments/reference.ts';
import { withAttachmentStore } from '../attachments/store.ts';
import { managedPeer, sameTarget } from '../chat/identity.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import type { MachineConfig, Session } from '../types.ts';
import {
  HISTORY_LIMITS,
  type NativeHistoryEntry,
  NativeHistoryEntrySchema,
  type NativeHistoryPage,
  NativeHistoryPageSchema,
} from './schema.ts';
import { nativeId, readContextJournal } from './store.ts';

const CursorSchema = z
  .object({
    registration: z.uuid(),
    nativeId: z.string().min(1).max(256),
    revision: z.number().int().nonnegative(),
    generation: z.uuid().nullable(),
    cursor: z.string().min(1).max(4_096),
  })
  .strict();
export function historyCursor(m: MachineConfig, s: Session, cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  let parsed: z.infer<typeof CursorSchema>;
  try {
    parsed = CursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new AppError('HISTORY_CURSOR', 'Native history cursor is invalid', 409);
  }
  if (
    parsed.registration !== s.registrationGeneration ||
    parsed.nativeId !== nativeId(s) ||
    parsed.revision !== readContextJournal(m, s).revision ||
    parsed.generation !== (readManagedRuntimeStatus(m, s).snapshot?.generation ?? null)
  )
    throw new AppError(
      'HISTORY_CURSOR',
      'Native history cursor no longer belongs to this context',
      409,
    );
  return parsed.cursor;
}
export function encodeHistoryCursor(
  m: MachineConfig,
  s: Session,
  cursor: string | null,
): string | null {
  if (cursor === null) return null;
  return Buffer.from(
    JSON.stringify(
      CursorSchema.parse({
        registration: s.registrationGeneration,
        nativeId: nativeId(s),
        revision: readContextJournal(m, s).revision,
        generation: readManagedRuntimeStatus(m, s).snapshot?.generation ?? null,
        cursor,
      }),
    ),
  ).toString('base64url');
}

/** Native image pointers are used only for an exact owner-store lookup, never returned to a reader. */
export async function historyImageReferences(
  m: MachineConfig,
  s: Session,
  pointers: string[],
  signal: AbortSignal,
): Promise<AttachmentReference[]> {
  if (pointers.length === 0) return [];
  return withAttachmentStore(
    m,
    'history-references',
    async (tx) => {
      const target = managedPeer(m.rcPrefix, s);
      const reachable = tx.store.pins
        .filter(
          (pin) => pin.registration === s.registrationGeneration && sameTarget(pin.target, target),
        )
        .flatMap((pin) => pin.references);
      const byPointer = new Map<string, AttachmentReference>();
      const retained = new Map(
        tx.store.records
          .filter((record) => record.phase === 'retained')
          .map((record) => [record.id, record]),
      );
      for (const reference of reachable) {
        const row = retained.get(reference.id);
        if (!row) continue;
        for (const pointer of [
          reference.id,
          attachmentPath(tx.root, row),
          `${reference.id}.png`,
          `${reference.id}.jpg`,
        ])
          byPointer.set(pointer, reference);
      }
      // Pins establish reachability, not presentation order. Native input order (including a
      // repeated image) is authoritative even if these assets were first pinned in another turn.
      const references = pointers
        .flatMap((pointer) => {
          const reference = byPointer.get(pointer);
          return reference ? [reference] : [];
        })
        .slice(0, 4);
      signal.throwIfAborted();
      return references;
    },
    signal,
  );
}
function boundedText(text: string, max: number): { text: string; omitted: number } {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return { text, omitted: 0 };
  let end = max;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), omitted: bytes.length - end };
}
export function boundedHistoryPage(
  m: MachineConfig,
  s: Session,
  entries: NativeHistoryEntry[],
  next: string | null,
  completeness: NativeHistoryPage['completeness'],
  omittedItems = 0,
): NativeHistoryPage {
  let remaining = HISTORY_LIMITS.textBytes,
    omittedBytes = 0;
  const bounded = entries.slice(0, HISTORY_LIMITS.entries).map((entry) => {
    const value =
      entry.text === null
        ? { text: null, omitted: 0 }
        : boundedText(entry.text, Math.min(remaining, HISTORY_LIMITS.itemBytes));
    remaining -= value.text === null ? 0 : Buffer.byteLength(value.text);
    omittedBytes += value.omitted + entry.omittedBytes;
    return NativeHistoryEntrySchema.parse({
      ...entry,
      text: value.text,
      omittedBytes: entry.omittedBytes + value.omitted,
    });
  });
  return NativeHistoryPageSchema.parse({
    runtime: s.agent,
    nativeId: nativeId(s),
    revision: readContextJournal(m, s).revision,
    entries: bounded,
    nextCursor: encodeHistoryCursor(m, s, next),
    completeness,
    omittedItems: omittedItems + Math.max(0, entries.length - bounded.length),
    omittedBytes,
  });
}
