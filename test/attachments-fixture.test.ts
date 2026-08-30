import { afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'jpeg-js';
import { PNG } from 'pngjs';
import { withPinnedAttachments } from '../src/attachments/pins.ts';
import { ATTACHMENT_LIMITS, type AttachmentReference } from '../src/attachments/reference.ts';
import {
  appendAttachmentChunk,
  beginAttachmentUpload,
  finalizeAttachmentUpload,
} from '../src/attachments/service.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { withSessionRegistryLock } from '../src/config/registryLock.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { makeCli, makeMachine, makeSession } from './helpers.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

export function imageBytes(
  format: 'png' | 'jpeg' = 'png',
  width = 4,
  height = 3,
  noise = false,
): Buffer<ArrayBuffer> {
  const png = new PNG({ width, height });
  let seed = 71;
  for (let i = 0; i < png.data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    png.data[i] = i % 4 === 3 ? 255 : noise ? seed >>> 24 : i % 3 === 0 ? 255 : 32;
  }
  return Buffer.from(format === 'png' ? PNG.sync.write(png) : encode(png, 90).data);
}

export function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function attachmentFixture() {
  const root = mkdtempSync('/tmp/ccmux-attachments-test-');
  temporary.push(root);
  const machine = makeMachine({
    stateDir: root,
    rcPrefix: 'host-a',
    projectsDir: join(root, 'history'),
  });
  const session = makeSession({
    agent: 'codex',
    runtime: 'app-server',
    name: 'image-agent',
    dir: root,
    registrationGeneration: crypto.randomUUID(),
  });
  await writeSessionsUnlocked(machine, [session]);
  const principal = makeCli('host-b'),
    target = managedPeer(machine.rcPrefix, session);
  const signal = new AbortController().signal;
  return { root, machine, session, principal, target, signal };
}

export type AttachmentFixture = Awaited<ReturnType<typeof attachmentFixture>>;

export async function upload(
  f: AttachmentFixture,
  bytes = imageBytes(),
  mediaType: 'image/png' | 'image/jpeg' = 'image/png',
) {
  const selector = { target: f.target, uploadId: crypto.randomUUID() };
  await beginAttachmentUpload(
    f.machine,
    f.principal,
    { ...selector, mediaType, totalBytes: bytes.length, digest: digest(bytes) },
    f.signal,
  );
  for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_LIMITS.chunkBytes) {
    await appendAttachmentChunk(
      f.machine,
      f.principal,
      {
        ...selector,
        offset,
        data: bytes.subarray(offset, offset + ATTACHMENT_LIMITS.chunkBytes).toString('base64'),
      },
      f.signal,
    );
  }
  return finalizeAttachmentUpload(f.machine, f.principal, selector, f.signal);
}

export async function pin<T>(
  f: AttachmentFixture,
  messageId: string,
  refs: AttachmentReference[],
  accept: () => Promise<T>,
) {
  return withSessionRegistryLock(f.machine, () =>
    withPinnedAttachments(f.machine, f.principal, f.target, messageId, refs, accept, f.signal),
  );
}
