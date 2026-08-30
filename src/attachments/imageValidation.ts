import { inflateSync } from 'node:zlib';
import { decode } from 'jpeg-js';
import { PNG } from 'pngjs';
import { z } from 'zod';
import { assertAttachment } from './errors.ts';
import { ATTACHMENT_LIMITS, AttachmentMediaTypeSchema } from './reference.ts';

export const DecodedImageSchema = z
  .object({
    mediaType: AttachmentMediaTypeSchema,
    width: z.number().int().positive().max(ATTACHMENT_LIMITS.dimension),
    height: z.number().int().positive().max(ATTACHMENT_LIMITS.dimension),
  })
  .strict();
export type DecodedImage = z.infer<typeof DecodedImageSchema>;

function dimensions(width: number, height: number): void {
  assertAttachment(
    width > 0 &&
      height > 0 &&
      width <= ATTACHMENT_LIMITS.dimension &&
      height <= ATTACHMENT_LIMITS.dimension &&
      width * height <= ATTACHMENT_LIMITS.pixels,
    'image-pixel-budget',
  );
}

function pngInflatedBytes(
  width: number,
  height: number,
  depth: number,
  channels: number,
  interlace: number,
): number {
  if (interlace === 0) return height * (1 + Math.ceil((width * depth * channels) / 8));
  assertAttachment(interlace === 1, 'png-interlace');
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  let size = 0;
  for (const pass of passes) {
    const [x, y, dx, dy] = pass;
    assertAttachment(
      x !== undefined && y !== undefined && dx !== undefined && dy !== undefined,
      'png-pass',
    );
    const w = Math.max(0, Math.ceil((width - x) / dx));
    const h = Math.max(0, Math.ceil((height - y) / dy));
    if (w > 0 && h > 0) size += h * (1 + Math.ceil((w * depth * channels) / 8));
  }
  return size;
}

function png(data: Buffer): DecodedImage {
  assertAttachment(
    data.length >= 45 && data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR',
    'png-header',
  );
  const width = data.readUInt32BE(16),
    height = data.readUInt32BE(20);
  dimensions(width, height);
  const depth = data[24],
    color = data[25],
    interlace = data[28];
  assertAttachment(
    depth !== undefined && [1, 2, 4, 8, 16].includes(depth) && interlace !== undefined,
    'png-format',
  );
  const channels =
    color === 0 || color === 3 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
  assertAttachment(channels > 0, 'png-color');
  const chunks: Buffer[] = [];
  let offset = 8,
    ended = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset),
      name = data.toString('ascii', offset + 4, offset + 8);
    assertAttachment(offset + 12 + length <= data.length, 'png-truncated-chunk');
    if (name === 'IDAT') chunks.push(data.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (name === 'IEND') {
      assertAttachment(length === 0 && offset === data.length, 'png-end');
      ended = true;
      break;
    }
  }
  assertAttachment(ended && chunks.length > 0, 'png-incomplete');
  const expected = pngInflatedBytes(width, height, depth, channels, interlace);
  // pngjs's Adam7 path has no inflate ceiling. Bound the complete zlib stream before decoding.
  const inflated = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected });
  assertAttachment(inflated.length === expected, 'png-pixel-data-length');
  const decoded = PNG.sync.read(data, { checkCRC: true });
  assertAttachment(
    decoded.width === width &&
      decoded.height === height &&
      decoded.data.length === width * height * 4,
    'png-decoded-size',
  );
  return { mediaType: 'image/png', width, height };
}

function jpeg(data: Buffer): DecodedImage {
  assertAttachment(
    data.length >= 4 && data.readUInt16BE(data.length - 2) === 0xffd9,
    'jpeg-incomplete',
  );
  let offset = 2,
    width = 0,
    height = 0;
  while (offset + 4 <= data.length) {
    assertAttachment(data[offset] === 0xff, 'jpeg-marker');
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    assertAttachment(
      marker !== undefined && marker !== 0xda && marker !== 0xd9,
      'jpeg-missing-frame',
    );
    assertAttachment(offset + 2 <= data.length, 'jpeg-truncated-length');
    const length = data.readUInt16BE(offset);
    assertAttachment(length >= 2 && offset + length <= data.length, 'jpeg-truncated-segment');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      assertAttachment(length >= 8, 'jpeg-frame');
      height = data.readUInt16BE(offset + 3);
      width = data.readUInt16BE(offset + 5);
      dimensions(width, height);
      break;
    }
    offset += length;
  }
  dimensions(width, height);
  const decoded = decode(data, {
    useTArray: true,
    tolerantDecoding: false,
    maxResolutionInMP: ATTACHMENT_LIMITS.pixels / 1_000_000,
    maxMemoryUsageInMB: 256,
  });
  assertAttachment(
    decoded.width === width &&
      decoded.height === height &&
      decoded.data.length === width * height * 4,
    'jpeg-decoded-size',
  );
  return { mediaType: 'image/jpeg', width, height };
}

/** Runs only inside the bounded decoder subprocess, never on the resident control event loop. */
export function validateImageBytes(data: Buffer): DecodedImage {
  assertAttachment(
    data.length > 0 && data.length <= ATTACHMENT_LIMITS.imageBytes,
    'image-byte-budget',
  );
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return png(data);
  if (data.length >= 2 && data.readUInt16BE(0) === 0xffd8) return jpeg(data);
  throw new Error('unsupported-image');
}
