import { expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { validateImageBytes } from '../src/attachments/imageValidation.ts';
import { ATTACHMENT_LIMITS } from '../src/attachments/reference.ts';
import { attachmentFixture, imageBytes, upload } from './attachments-fixture.test.ts';

test('actual decoding rejects header-only, truncated entropy, MIME mismatch and over-budget images', async () => {
  for (const format of ['png', 'jpeg']) {
    if (format !== 'png' && format !== 'jpeg') throw new Error('fixture format');
    const good = imageBytes(format);
    expect(validateImageBytes(good)).toMatchObject({ width: 4, height: 3 });
    expect(() => validateImageBytes(good.subarray(0, good.length - 5))).toThrow();
    expect(() => validateImageBytes(good.subarray(0, 35))).toThrow();
  }
  const bomb = imageBytes();
  bomb.writeUInt32BE(8193, 16);
  expect(() => validateImageBytes(bomb)).toThrow('image-pixel-budget');
  const f = await attachmentFixture();
  await expect(upload(f, imageBytes('jpeg'), 'image/png')).rejects.toMatchObject({
    code: 'ATTACHMENT_UNAVAILABLE',
  });
});

test('PNG inflate is bounded by exact declared scanlines, not compressed size', () => {
  const original = imageBytes(),
    compressed = deflateSync(Buffer.alloc(1024 * 1024));
  const idat = Buffer.alloc(12 + compressed.length);
  idat.writeUInt32BE(compressed.length, 0);
  idat.write('IDAT', 4, 'ascii');
  compressed.copy(idat, 8);
  const bad = Buffer.concat([
    original.subarray(0, 33),
    idat,
    original.subarray(original.length - 12),
  ]);
  expect(() => validateImageBytes(bad)).toThrow();
});

/**
 * A near-limit image goes the client's way: about 340 durable chunk writes of `chunkBytes`, then one
 * out-of-process decode. Measured at load average 19: 2.7 s of writes and 1.2 s of decode. The
 * decode is bounded by the product (`decodeDeadlineMs`: past it the decoder refuses with a reason);
 * the writes have no bound of their own and slow with the disk other work shares. The suite's 20 s
 * was shorter than either, so at load 107 the test was cut before the product answered — a timeout
 * that said nothing about the decoder. Its bound is the decoder's deadline plus a stated budget for
 * the writes; a hang still fails it.
 */
const CHUNK_WRITES_BUDGET_MS = 30_000;
const DECODE_TEST_TIMEOUT_MS = ATTACHMENT_LIMITS.decodeDeadlineMs + CHUNK_WRITES_BUDGET_MS;

test(
  'near-limit image decodes out of process while the resident event loop remains responsive',
  async () => {
    const f = await attachmentFixture(),
      bytes = imageBytes('png', 1550, 1550, true);
    expect(bytes.length).toBeGreaterThan(ATTACHMENT_LIMITS.imageBytes * 0.9);
    expect(bytes.length).toBeLessThanOrEqual(ATTACHMENT_LIMITS.imageBytes);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const reference = await upload(f, bytes);
      expect(reference).toMatchObject({ width: 1550, height: 1550, bytes: bytes.length });
      expect(ticks).toBeGreaterThan(4);
    } finally {
      clearInterval(timer);
    }
  },
  DECODE_TEST_TIMEOUT_MS,
);
