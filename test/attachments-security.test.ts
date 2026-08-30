import { expect, test } from 'bun:test';
import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { attachmentPath } from '../src/attachments/files.ts';
import { ATTACHMENT_LIMITS } from '../src/attachments/reference.ts';
import { AttachmentBeginSchema } from '../src/attachments/schema.ts';
import {
  appendAttachmentChunk,
  beginAttachmentUpload,
  readAttachmentChunk,
} from '../src/attachments/service.ts';
import { withAttachmentStore } from '../src/attachments/store.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { attachmentFixture, digest, imageBytes, upload } from './attachments-fixture.test.ts';

test('unknown principal, wrong target and mismatched immutable reference cannot preview', async () => {
  const f = await attachmentFixture(),
    reference = await upload(f);
  const input = { target: f.target, reference, offset: 0 };
  await expect(
    readAttachmentChunk(f.machine, { ...f.principal, machine: 'host-c' }, input, f.signal),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  await expect(
    readAttachmentChunk(
      f.machine,
      f.principal,
      { ...input, target: { ...f.target, threadId: crypto.randomUUID() } },
      f.signal,
    ),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  await expect(
    readAttachmentChunk(
      f.machine,
      f.principal,
      { ...input, reference: { ...reference, digest: '0'.repeat(64) } },
      f.signal,
    ),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  expect(
    AttachmentBeginSchema.safeParse({
      target: f.target,
      uploadId: '../outside',
      mediaType: 'image/png',
      totalBytes: 1,
      digest: '0'.repeat(64),
    }).success,
  ).toBe(false);
});

test('symlinked blobs and store roots refuse without reading or changing the link target', async () => {
  const f = await attachmentFixture(),
    reference = await upload(f);
  const path = attachmentPath(join(f.root, 'attachments'), reference),
    outside = join(f.root, 'outside.txt');
  const secret = 'private-fixture-content-not-for-response';
  writeFileSync(outside, secret, { mode: 0o600 });
  unlinkSync(path);
  symlinkSync(outside, path);
  await expect(
    readAttachmentChunk(
      f.machine,
      f.principal,
      { target: f.target, reference, offset: 0 },
      f.signal,
    ),
  ).rejects.toMatchObject({
    code: 'ATTACHMENT_UNAVAILABLE',
    message: 'The image attachment is unavailable',
  });
  expect(readFileSync(outside, 'utf8')).toBe(secret);
  const other = await attachmentFixture();
  symlinkSync(f.root, join(other.root, 'attachments'));
  await expect(
    beginAttachmentUpload(
      other.machine,
      other.principal,
      {
        target: other.target,
        uploadId: crypto.randomUUID(),
        mediaType: 'image/png',
        totalBytes: 1,
        digest: '0'.repeat(64),
      },
      other.signal,
    ),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
});

test('expired unretained images are reaped, but expired bytes never become usable', async () => {
  const f = await attachmentFixture(),
    reference = await upload(f);
  await withAttachmentStore(f.machine, 'fixture-expire', async (tx) => {
    const row = tx.store.records[0];
    if (!row) throw new Error('missing fixture');
    row.expiresAt = 0;
    tx.persist();
  });
  await expect(
    readAttachmentChunk(
      f.machine,
      f.principal,
      { target: f.target, reference, offset: 0 },
      f.signal,
    ),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  const count = await withAttachmentStore(
    f.machine,
    'fixture-count',
    async (tx) => tx.store.records.length,
  );
  expect(count).toBe(0);
});

test('interrupted chunk fsync recovers unacknowledged tail and never accepts a short committed file', async () => {
  const f = await attachmentFixture(),
    bytes = imageBytes();
  const selector = { target: f.target, uploadId: crypto.randomUUID() };
  await beginAttachmentUpload(
    f.machine,
    f.principal,
    { ...selector, mediaType: 'image/png', totalBytes: bytes.length, digest: digest(bytes) },
    f.signal,
  );
  const path = attachmentPath(join(f.root, 'attachments'), {
    id: selector.uploadId,
    mediaType: 'image/png',
  });
  writeFileSync(path, Buffer.alloc(30, 0xa5));
  expect(
    (
      await appendAttachmentChunk(
        f.machine,
        f.principal,
        { ...selector, offset: 0, data: bytes.subarray(0, 20).toString('base64') },
        f.signal,
      )
    ).receivedBytes,
  ).toBe(20);
  expect(readFileSync(path)).toEqual(bytes.subarray(0, 20));
  const fd = openSync(path, constants.O_WRONLY);
  ftruncateSync(fd, 10);
  closeSync(fd);
  await expect(
    appendAttachmentChunk(
      f.machine,
      f.principal,
      { ...selector, offset: 20, data: bytes.subarray(20).toString('base64') },
      f.signal,
    ),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
});

test('preview cache validates changes even when byte count and attachment ID stay equal', async () => {
  const f = await attachmentFixture(),
    reference = await upload(f),
    input = { target: f.target, reference, offset: 0 };
  await readAttachmentChunk(f.machine, f.principal, input, f.signal);
  const path = attachmentPath(join(f.root, 'attachments'), reference);
  const corrupted = readFileSync(path);
  corrupted[corrupted.length - 1] = 0;
  writeFileSync(path, corrupted);
  await expect(readAttachmentChunk(f.machine, f.principal, input, f.signal)).rejects.toMatchObject({
    code: 'ATTACHMENT_UNAVAILABLE',
  });
});

test('per-target upload admission reserves bytes before creation and abort never mutates', async () => {
  const f = await attachmentFixture();
  const input = {
    target: f.target,
    uploadId: crypto.randomUUID(),
    mediaType: 'image/png',
    totalBytes: 1,
    digest: '0'.repeat(64),
  };
  for (let i = 0; i < 8; i++)
    await beginAttachmentUpload(
      f.machine,
      f.principal,
      { ...input, mediaType: 'image/png', uploadId: crypto.randomUUID() },
      f.signal,
    );
  await expect(
    beginAttachmentUpload(f.machine, f.principal, { ...input, mediaType: 'image/png' }, f.signal),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(
    beginAttachmentUpload(
      f.machine,
      f.principal,
      { ...input, mediaType: 'image/png' },
      controller.signal,
    ),
  ).rejects.toThrow('cancelled');
  expect(
    await withAttachmentStore(f.machine, 'fixture-count', async (tx) => tx.store.records.length),
  ).toBe(8);
});

test('host disk quota accounts for all reserved bytes and expiry releases only unretained reservations', async () => {
  const f = await attachmentFixture();
  const sessions = Array.from({ length: 4 }, (_, index) => ({
    ...f.session,
    name: `image-agent-${index}`,
    uuid: crypto.randomUUID(),
    registrationGeneration: crypto.randomUUID(),
  }));
  await writeSessionsUnlocked(f.machine, sessions);
  for (const session of sessions)
    for (let index = 0; index < 8; index++) {
      await beginAttachmentUpload(
        f.machine,
        f.principal,
        {
          target: managedPeer(f.machine.rcPrefix, session),
          uploadId: crypto.randomUUID(),
          mediaType: 'image/png',
          totalBytes: ATTACHMENT_LIMITS.imageBytes,
          digest: '0'.repeat(64),
        },
        f.signal,
      );
    }
  const session = sessions[0];
  if (!session) throw new Error('fixture missing');
  const input = {
    target: managedPeer(f.machine.rcPrefix, session),
    uploadId: crypto.randomUUID(),
    totalBytes: 1,
    digest: '0'.repeat(64),
  };
  await expect(
    beginAttachmentUpload(f.machine, f.principal, { ...input, mediaType: 'image/png' }, f.signal),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  expect(readFileSync(join(f.root, 'attachments', 'last-failure.json'), 'utf8')).toContain(
    'attachment-disk-quota',
  );
  await withAttachmentStore(f.machine, 'fixture-expire', async (tx) => {
    for (const row of tx.store.records) row.expiresAt = 0;
    tx.persist();
  });
  expect(
    (
      await beginAttachmentUpload(
        f.machine,
        f.principal,
        { ...input, mediaType: 'image/png' },
        f.signal,
      )
    ).receivedBytes,
  ).toBe(0);
});

test("symlinked owner lock cannot reap another directory's owner file", async () => {
  const f = await attachmentFixture();
  await withAttachmentStore(f.machine, 'fixture-init', async () => undefined);
  const outside = join(f.root, 'outside-lock');
  mkdirSync(outside, { mode: 0o700 });
  const owner = JSON.stringify({ pid: 999_999_999, token: crypto.randomUUID() });
  writeFileSync(join(outside, 'owner.json'), owner);
  symlinkSync(outside, join(f.root, 'attachments', '.lock'));
  await expect(
    withAttachmentStore(f.machine, 'fixture-lock', async () => true),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  expect(readFileSync(join(outside, 'owner.json'), 'utf8')).toBe(owner);
});
