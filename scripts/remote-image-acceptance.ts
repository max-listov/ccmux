import { PNG } from 'pngjs';
import { z } from 'zod';
import {
  check,
  geometryImage,
  modelCatalog,
  nearLimitImage,
  refusal,
  report,
  until,
} from './native-image-steering-fixture.ts';
import {
  type ImageService,
  type ImageSession,
  remoteImageTurn,
  remoteUpload,
  retainedRemotePreview,
} from './remote-image-operations.ts';

export const RemoteImageOptionsSchema = z.strictObject({
  workspace: z.string().startsWith('/'),
  namePrefix: z.string().regex(/^image-accept-[a-z0-9]{8}$/),
  runtimes: z
    .array(z.enum(['codex', 'opencode']))
    .min(1)
    .max(2),
});

/** The caller supplies the supported authenticated cross-machine service transport. */
export async function remoteImageAcceptance(service: ImageService, input: unknown) {
  const options = RemoteImageOptionsSchema.parse(input);
  const created: ImageSession[] = [];
  const failures: unknown[] = [];
  try {
    for (const runtime of options.runtimes) {
      const models = await modelCatalog({ service }, runtime);
      const eligible = models.filter((model) => model.inputModalities.includes('image'));
      const model =
        runtime === 'codex'
          ? (eligible.find((row) => row.id === 'gpt-5.6-luna') ?? eligible[0])
          : eligible.find(
              (row) => row.provider === 'openrouter' && row.id === 'google/gemini-2.5-flash',
            );
      check(model, `No configured ${runtime} image model`);
      const provider = runtime === 'codex' ? 'openai' : model.provider;
      check(provider, 'Native image model has no provider identity');
      const request = {
        requestId: crypto.randomUUID(),
        name: `${options.namePrefix}-${runtime}`,
        workspace: options.workspace,
        runtime,
        modelSelection: { provider, model: model.model ?? model.id },
      };
      const session = await service.create(request);
      created.push(session);
      report('remote-image-session', session);
      const retry = await service.create(request);
      check(
        retry.duplicate &&
          retry.target.threadId === session.target.threadId &&
          retry.registrationGeneration === session.registrationGeneration,
        'Create retry changed managed identity',
      );
      await until('remote image session ready', async () => {
        try {
          return (await service.get({ target: session.target })).state === 'idle';
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'UNAVAILABLE')
            return false;
          throw error;
        }
      });
      // A lossless desktop-sized fixture exceeds the complete service message envelope.
      const png = PNG.sync.write(PNG.sync.read(geometryImage('png')), { deflateLevel: 0 });
      check(png.length > 64 * 1024, 'Fixture fits inside the message envelope');
      const jpeg = geometryImage('jpeg');
      const first = await remoteUpload(service, session, png, 'image/png');
      const second = await remoteUpload(service, session, jpeg, 'image/jpeg');
      const one = await remoteImageTurn(
        service,
        session,
        [first],
        "For this and each following image, report only the left object's color and shape, then the right object's color and shape, in English. Inspect actual pixels. No tools or questions.",
      );
      check(
        /red\s+circle/i.test(one.text) && /blue\s+square/i.test(one.text),
        'PNG vision differs',
      );
      const two = await remoteImageTurn(service, session, [second], '');
      check(
        /green\s+triangle/i.test(two.text) && /yellow\s+circle/i.test(two.text),
        'Image-only JPEG vision differs',
      );
      for (const images of [
        [first, second],
        [second, first],
      ]) {
        const ordered = await remoteImageTurn(
          service,
          session,
          images,
          'Describe both images in attachment order: left then right object, color and shape, one numbered line per image, English. No tools.',
        );
        const positions = images
          .flatMap((image) =>
            image.mediaType === 'image/png'
              ? [/red\s+circle/i, /blue\s+square/i]
              : [/green\s+triangle/i, /yellow\s+circle/i],
          )
          .map((pattern) => ordered.text.search(pattern));
        check(
          positions.every(
            (position, index) =>
              position >= 0 && (index === 0 || position > (positions[index - 1] ?? Infinity)),
          ),
          'Remote visual image order differs',
        );
        await refusal(
          () => service.message({ ...ordered.request, images: [...images].reverse() }),
          'IDEMPOTENCY_CONFLICT',
        );
      }
      const bytes = nearLimitImage();
      const large = await remoteUpload(service, session, bytes, 'image/png');
      const answer = await remoteImageTurn(
        service,
        session,
        [large],
        'Describe the texture of the attached image briefly in English. Inspect actual pixels. No tools.',
      );
      check(
        /noise|static|random|pixel|colou?r/i.test(answer.text),
        'Near-limit image not described',
      );
      await retainedRemotePreview(service, session, [
        { reference: first, bytes: png },
        { reference: second, bytes: jpeg },
        { reference: large, bytes },
      ]);
      report('remote-image-acceptance-pass', {
        runtime,
        imageOnly: true,
        textAndImage: true,
        orderedImages: true,
        changedOrderRefused: true,
        nearLimitBytes: bytes.length,
        historyAndPreview: true,
        sameIdRetry: true,
      });
    }
  } catch (error) {
    failures.push(error);
    report('remote-image-failure', {
      message: error instanceof Error ? error.message : 'Unknown acceptance failure',
      code: error instanceof Error && 'code' in error ? error.code : null,
    });
  } finally {
    let archived = 0;
    const cleanupFailures: unknown[] = [];
    // The supplied transport may allow only one in-flight operation.
    for (const session of created) {
      try {
        await service.archive({ target: session.target });
        archived++;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    failures.push(...cleanupFailures);
    report('remote-image-cleanup', {
      created: created.length,
      archived,
      failures: cleanupFailures.map((error) => ({
        code: error instanceof Error && 'code' in error ? error.code : 'UNKNOWN',
      })),
    });
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Remote image acceptance or cleanup failed');
}
