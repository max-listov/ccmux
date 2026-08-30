import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { validateImageBytes } from "../src/attachments/imageValidation.ts";
import { ATTACHMENT_LIMITS } from "../src/attachments/reference.ts";
import { attachmentFixture, imageBytes, upload } from "./attachments-fixture.test.ts";

test("actual decoding rejects header-only, truncated entropy, MIME mismatch and over-budget images", async () => {
  for (const format of ["png", "jpeg"]) {
    if (format !== "png" && format !== "jpeg") throw new Error("fixture format");
    const good = imageBytes(format);
    expect(validateImageBytes(good)).toMatchObject({ width: 4, height: 3 });
    expect(() => validateImageBytes(good.subarray(0, good.length - 5))).toThrow();
    expect(() => validateImageBytes(good.subarray(0, 35))).toThrow();
  }
  const bomb = imageBytes(); bomb.writeUInt32BE(8193, 16);
  expect(() => validateImageBytes(bomb)).toThrow("image-pixel-budget");
  const f = await attachmentFixture();
  await expect(upload(f, imageBytes("jpeg"), "image/png")).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
});

test("PNG inflate is bounded by exact declared scanlines, not compressed size", () => {
  const original = imageBytes(), compressed = deflateSync(Buffer.alloc(1024 * 1024));
  const idat = Buffer.alloc(12 + compressed.length);
  idat.writeUInt32BE(compressed.length, 0); idat.write("IDAT", 4, "ascii"); compressed.copy(idat, 8);
  const bad = Buffer.concat([original.subarray(0, 33), idat, original.subarray(original.length - 12)]);
  expect(() => validateImageBytes(bad)).toThrow();
});

test("near-limit image decodes out of process while the resident event loop remains responsive", async () => {
  const f = await attachmentFixture(), bytes = imageBytes("png", 1550, 1550, true);
  expect(bytes.length).toBeGreaterThan(ATTACHMENT_LIMITS.imageBytes * 0.9);
  expect(bytes.length).toBeLessThanOrEqual(ATTACHMENT_LIMITS.imageBytes);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const reference = await upload(f, bytes);
    expect(reference).toMatchObject({ width: 1550, height: 1550, bytes: bytes.length });
    expect(ticks).toBeGreaterThan(4);
  } finally { clearInterval(timer); }
}, 15_000);
