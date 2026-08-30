import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTACHMENT_LIMITS } from '../src/attachments/reference.ts';
import { AttachmentChunkSchema } from '../src/attachments/schema.ts';
import {
  appendAttachmentChunk,
  beginAttachmentUpload,
  cancelAttachmentUpload,
  finalizeAttachmentUpload,
  readAttachmentChunk,
} from '../src/attachments/service.ts';
import { attachmentFixture, digest, imageBytes, upload } from './attachments-fixture.test.ts';

test('PNG and JPEG transfers decode in an owner subprocess and return path-free immutable receipts', async () => {
  for (const format of ['png', 'jpeg']) {
    if (format !== 'png' && format !== 'jpeg') throw new Error('fixture format');
    const f = await attachmentFixture(),
      bytes = imageBytes(format);
    const ref = await upload(f, bytes, format === 'png' ? 'image/png' : 'image/jpeg');
    expect(ref).toMatchObject({ bytes: bytes.length, digest: digest(bytes), width: 4, height: 3 });
    expect(JSON.stringify(ref)).not.toContain(f.root);
    expect(JSON.stringify(ref)).not.toContain(bytes.toString('base64'));
    expect(
      await finalizeAttachmentUpload(
        f.machine,
        f.principal,
        { target: f.target, uploadId: ref.id },
        f.signal,
      ),
    ).toEqual(ref);
    const preview = await readAttachmentChunk(
      f.machine,
      f.principal,
      { target: f.target, reference: ref, offset: 0 },
      f.signal,
    );
    expect(Buffer.from(preview.data, 'base64')).toEqual(bytes);
    expect(preview.complete).toBe(true);
  }
});

test('chunk replay is idempotent while gaps, overlapping bytes and changed content fail closed', async () => {
  const f = await attachmentFixture(),
    bytes = imageBytes();
  const input = {
    target: f.target,
    uploadId: crypto.randomUUID(),
    mediaType: 'image/png',
    totalBytes: bytes.length,
    digest: digest(bytes),
  };
  const begin = await beginAttachmentUpload(
    f.machine,
    f.principal,
    { ...input, mediaType: 'image/png' },
    f.signal,
  );
  expect(
    await beginAttachmentUpload(
      f.machine,
      f.principal,
      { ...input, mediaType: 'image/png' },
      f.signal,
    ),
  ).toEqual(begin);
  const part = {
    target: f.target,
    uploadId: input.uploadId,
    offset: 0,
    data: bytes.subarray(0, 20).toString('base64'),
  };
  const first = await appendAttachmentChunk(f.machine, f.principal, part, f.signal);
  expect(await appendAttachmentChunk(f.machine, f.principal, part, f.signal)).toEqual(first);
  await expect(
    appendAttachmentChunk(f.machine, f.principal, { ...part, offset: 21 }, f.signal),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  await expect(
    appendAttachmentChunk(f.machine, f.principal, { ...part, offset: 10 }, f.signal),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  await expect(
    appendAttachmentChunk(
      f.machine,
      f.principal,
      { ...part, data: Buffer.alloc(20).toString('base64') },
      f.signal,
    ),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  const selector = { target: input.target, uploadId: input.uploadId };
  await expect(
    finalizeAttachmentUpload(f.machine, f.principal, selector, f.signal),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  await appendAttachmentChunk(
    f.machine,
    f.principal,
    { ...part, offset: 20, data: bytes.subarray(20).toString('base64') },
    f.signal,
  );
  expect((await finalizeAttachmentUpload(f.machine, f.principal, selector, f.signal)).digest).toBe(
    digest(bytes),
  );
});

test('a screenshot larger than the control envelope transfers and previews in bounded chunks', async () => {
  const f = await attachmentFixture(),
    bytes = imageBytes('png', 320, 240, true);
  expect(bytes.length).toBeGreaterThan(64 * 1024);
  const ref = await upload(f, bytes),
    collected: Buffer[] = [];
  let offset = 0;
  do {
    const read = await readAttachmentChunk(
      f.machine,
      f.principal,
      { target: f.target, reference: ref, offset },
      f.signal,
    );
    expect(read.data.length).toBeLessThanOrEqual((ATTACHMENT_LIMITS.chunkBytes / 3) * 4);
    collected.push(Buffer.from(read.data, 'base64'));
    offset = read.nextOffset;
  } while (offset < bytes.length);
  expect(Buffer.concat(collected)).toEqual(bytes);
  expect(
    AttachmentChunkSchema.safeParse({
      target: f.target,
      uploadId: ref.id,
      offset: 0,
      data: 'A'.repeat(32772),
    }).success,
  ).toBe(false);
});

test('cancel removes only the selected unretained image and keeps failure diagnostics private', async () => {
  const f = await attachmentFixture(),
    first = await upload(f),
    second = await upload(f);
  expect(
    await cancelAttachmentUpload(
      f.machine,
      f.principal,
      { target: f.target, uploadId: first.id },
      f.signal,
    ),
  ).toEqual({ uploadId: first.id, cancelled: true });
  expect(
    await cancelAttachmentUpload(
      f.machine,
      f.principal,
      { target: f.target, uploadId: first.id },
      f.signal,
    ),
  ).toEqual({ uploadId: first.id, cancelled: true });
  await expect(
    readAttachmentChunk(
      f.machine,
      f.principal,
      { target: f.target, reference: first, offset: 0 },
      f.signal,
    ),
  ).rejects.toMatchObject({
    code: 'ATTACHMENT_UNAVAILABLE',
    message: 'The image attachment is unavailable',
  });
  expect(
    (
      await readAttachmentChunk(
        f.machine,
        f.principal,
        { target: f.target, reference: second, offset: 0 },
        f.signal,
      )
    ).complete,
  ).toBe(true);
  expect(readFileSync(join(f.root, 'attachments', 'last-failure.json'), 'utf8')).toContain(
    'attachment-scope',
  );
});
