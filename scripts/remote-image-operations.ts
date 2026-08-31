import type { AttachmentReference } from '../src/attachments/reference.ts';
import type { createCcmuxControlServiceClient } from '../src/control/serviceClient.ts';
import {
  check,
  previewImage,
  report,
  until,
  uploadImage,
} from './native-image-steering-fixture.ts';

export type ImageService = ReturnType<typeof createCcmuxControlServiceClient>;
export type ImageSession = Awaited<ReturnType<ImageService['create']>>;

export async function remoteUpload(
  service: ImageService,
  session: ImageSession,
  bytes: Buffer,
  mediaType: 'image/png' | 'image/jpeg',
) {
  const reference = await uploadImage({ service }, session.target, bytes, mediaType);
  report('remote-image-upload', {
    runtime: session.target.agent,
    bytes: bytes.length,
    digest: reference.digest,
    previewExact: true,
  });
  return reference;
}

export async function remoteImageTurn(
  service: ImageService,
  session: ImageSession,
  images: AttachmentReference[],
  body: string,
) {
  const { target, registrationGeneration } = session;
  const selector = { target, registrationGeneration, messageId: crypto.randomUUID() };
  const request = { ...selector, body, images, notification: 'conversation' } satisfies Parameters<
    ImageService['message']
  >[0];
  const receipt = await service.message(request);
  check(receipt.notification === 'conversation', 'Fixture notification audience changed');
  check((await service.message(request)).duplicate, 'Image retry duplicated admission');
  let operation = await service.messageOperation(selector);
  await until('exact remote image turn', async () => {
    operation = await service.messageOperation(selector);
    check(operation.evidence?.state !== 'failed', 'Remote model turn failed');
    check(operation.evidence?.state !== 'interrupted', 'Remote model turn interrupted');
    return operation.evidence?.state === 'completed';
  });
  const turnId = operation.evidence?.turnId;
  check(turnId, 'Image message has no exact native turn');
  let native = await service.native({ target });
  await until('completed native image content', async () => {
    native = await service.native({ target });
    return native.baseline.some(
      (row) => row.turnId === turnId && row.kind === 'assistant' && row.complete,
    );
  });
  const text = native.baseline
    .filter((row) => row.turnId === turnId && row.kind === 'assistant' && row.complete)
    .map((row) => row.text ?? '')
    .join(' ');
  check(text.length > 0, 'Image turn returned no native assistant content');
  const encoded = JSON.stringify(native);
  check(!encoded.includes('data:image/'), 'Inline image bytes leaked into native projection');
  check(Buffer.byteLength(encoded) <= 512 * 1024, 'Native image projection exceeds its bound');
  const history = await service.history({ target, registrationGeneration, limit: 64 });
  const received = history.entries
    .filter((row) => row.turnId === turnId)
    .flatMap((row) => row.images);
  check(
    received.length === images.length &&
      received.every((image, index) => image.digest === images[index]?.digest),
    'Exact-turn native history changed image order',
  );
  check(Buffer.byteLength(JSON.stringify(history)) < 384 * 1024, 'Image history exceeds bound');
  report('remote-image-turn', {
    runtime: target.agent,
    turnId,
    messageId: selector.messageId,
    answer: text,
    imageCount: images.length,
    exactCorrelation: true,
    sameIdRetry: true,
    notification: receipt.notification,
    historyBytes: Buffer.byteLength(JSON.stringify(history)),
    nativeBytes: Buffer.byteLength(encoded),
  });
  return { text, request };
}

export async function retainedRemotePreview(
  service: ImageService,
  session: ImageSession,
  images: Array<{ reference: AttachmentReference; bytes: Buffer }>,
) {
  for (const image of images)
    await previewImage({ service }, session.target, image.reference, image.bytes);
  report('remote-retained-preview', { runtime: session.target.agent, count: images.length });
}
