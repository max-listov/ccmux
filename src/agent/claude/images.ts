import { createHash } from 'node:crypto';
import type { TranscriptImage } from '../transcript/messageSchema.ts';
import { rec, str } from '../transcript/normalize.ts';
import { contentItems } from './content.ts';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Upper blocks use #outer; tool-result parts use #outer/inner. Both index the source. */
export function imageDescriptor(
  item: Record<string, unknown>,
  entryUuid: string,
  index: number,
  inner?: number,
): TranscriptImage {
  const address = `${entryUuid}#${index}${inner === undefined ? '' : `/${inner}`}`;
  const source = rec(item.source);
  const mediaType = str(source?.media_type);
  const unavailable = (
    reason: TranscriptImage['unavailable'],
    bytes: number | null = null,
  ): TranscriptImage => ({ address, mediaType, bytes, digest: null, unavailable: reason });
  if (str(source?.type) !== 'base64') return unavailable('unsupported-source');
  const data = str(source?.data);
  if (!data) return unavailable('malformed');
  const bytes =
    Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) return unavailable('too-large', bytes);
  if (data.length % 4 !== 0 || !BASE64.test(data)) return unavailable('malformed');
  return {
    address,
    mediaType,
    bytes,
    digest: createHash('sha256').update(data).digest('hex'),
    unavailable: null,
  };
}

/** No bytes on messages; readers ask for them only when displaying the image. */
export function resultImages(
  item: Record<string, unknown>,
  uuid: string,
  outer: number,
): TranscriptImage[] {
  if (!Array.isArray(item.content)) return [];
  return item.content.flatMap((value, inner) => {
    const block = rec(value);
    return block && block.type === 'image' ? [imageDescriptor(block, uuid, outer, inner)] : [];
  });
}

export function readImage(
  lines: string[],
  address: string,
): { mediaType: string | null; data: string } | { unavailable: TranscriptImage['unavailable'] } {
  const match = /^([^#/]+)#(0|[1-9]\d*)(?:\/(0|[1-9]\d*))?$/.exec(address);
  if (!match || address.length > 256) return { unavailable: 'malformed' };
  const [, uuid, outerRaw, innerRaw] = match;
  const outer = Number(outerRaw);
  const inner = innerRaw === undefined ? undefined : Number(innerRaw);
  if (
    !uuid ||
    !Number.isSafeInteger(outer) ||
    (inner !== undefined && !Number.isSafeInteger(inner))
  )
    return { unavailable: 'malformed' };
  for (const raw of lines) {
    if (!raw.includes(uuid)) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = rec(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!entry || str(entry.uuid) !== uuid) continue;
    let item = rec(contentItems(entry)[outer]);
    if (inner !== undefined) {
      if (item?.type !== 'tool_result' || !Array.isArray(item.content))
        return { unavailable: 'malformed' };
      item = rec(item.content[inner]);
    }
    if (item?.type !== 'image') return { unavailable: 'malformed' };
    const descriptor = imageDescriptor(item, uuid, outer, inner);
    if (descriptor.unavailable !== null) return { unavailable: descriptor.unavailable };
    const data = str(rec(item.source)?.data);
    if (!data) return { unavailable: 'malformed' };
    return { mediaType: descriptor.mediaType, data };
  }
  return { unavailable: 'malformed' };
}
