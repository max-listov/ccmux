#!/usr/bin/env bun
import { join } from 'node:path';
import type { AttachmentReference } from '../src/attachments/reference.ts';
import { loadLedger } from '../src/chat/store.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { readManagedRuntimeStatus } from '../src/runtime/status.ts';
import { killSession } from '../src/tmux/tmux.ts';
import type { ManagedPeer } from '../src/types.ts';
import {
  check,
  geometryImage,
  modelCatalog,
  type NativeImageProbe,
  nativeImageProbe,
  nearLimitImage,
  previewImage,
  refusal,
  report,
  sha,
  streamFrame,
  until,
  uploadImage,
} from './native-image-steering-fixture.ts';

type Created = Awaited<ReturnType<NativeImageProbe['service']['create']>>;
async function idle(p: NativeImageProbe, target: ManagedPeer) {
  await until('native idle', async () => {
    try {
      return (await p.service.get({ target })).state === 'idle';
    } catch {
      return false;
    }
  });
}
async function completed(
  p: NativeImageProbe,
  target: ManagedPeer,
  before: { generation: string; sequence: number },
) {
  const records: Awaited<ReturnType<typeof p.service.native>>['records'] = [];
  let cursor = before;
  await until('native completion', async () => {
    const frame = await p.service.native({ target, cursor });
    check(
      !JSON.stringify(frame).includes('data:image/'),
      'Inline image bytes leaked into content stream',
    );
    records.push(...frame.baseline, ...frame.records);
    cursor = { generation: frame.generation, sequence: frame.sequence };
    const waited = await p.service.wait({ target, timeoutMs: 500 });
    check(waited.outcome !== 'failed', 'Native model failed');
    return (
      waited.outcome === 'completed' &&
      records.some((row) => row.kind === 'assistant' && row.complete)
    );
  });
  return records
    .filter((row) => row.kind === 'assistant')
    .map((row) => row.text ?? '')
    .join(' ');
}
async function orderedImages(
  p: NativeImageProbe,
  created: Created,
  references: AttachmentReference[],
) {
  const before = await p.service.native({ target: created.target });
  const request = {
    target: created.target,
    messageId: crypto.randomUUID(),
    images: references,
    body: "Inspect the two images attached to this message. In attachment order, write one numbered line per image describing the left object's color and shape, then the right object's color and shape. Use English. No tools, other messages or follow-up questions.",
  };
  await p.service.message(request);
  check((await p.service.message(request)).duplicate, 'Multiple-image retry changed identity');
  await refusal(
    () => p.service.message({ ...request, images: [...references].reverse() }),
    'IDEMPOTENCY_CONFLICT',
  );
  const answer = await completed(p, created.target, {
    generation: before.generation,
    sequence: before.sequence,
  });
  const patterns = references.flatMap((reference) =>
    reference.mediaType === 'image/png'
      ? [/red\s+circle/i, /blue\s+square/i]
      : [/green\s+triangle/i, /yellow\s+circle/i],
  );
  const positions = patterns.map((pattern) => answer.search(pattern));
  check(
    positions.every(
      (position, index) =>
        position >= 0 && (index === 0 || position > (positions[index - 1] ?? Infinity)),
    ),
    'Multiple-image semantic order differs from attachment order',
  );
  const history = await p.service.history({
    target: created.target,
    registrationGeneration: created.registrationGeneration,
    limit: 32,
  });
  const current = await p.service.get({ target: created.target });
  check(current.turn, 'Multiple-image native turn missing');
  const historyImages = history.entries
    .filter((row) => row.turnId === current.turn?.id)
    .flatMap((row) => row.images);
  check(
    historyImages.length === references.length &&
      historyImages.every((image, index) => image.digest === references[index]?.digest),
    'History changed multiple-image order',
  );
  check(
    loadLedger(p.machine).filter((row) => row?.id === request.messageId).length === 1,
    'Multiple-image retry duplicated ledger acceptance',
  );
  report('ordered-multiple-images', {
    runtime: created.target.agent,
    answer,
    count: references.length,
    imageHashes: references.map((reference) => reference.digest),
    nativeOrder: true,
    historyOrder: true,
    sameIdRetry: true,
    sameIdReversedOrderRefused: true,
    oneAcceptedMessage: true,
  });
}
async function vision(p: NativeImageProbe, created: Created) {
  const { target, registrationGeneration } = created;
  await idle(p, target);
  const png = geometryImage('png'),
    jpeg = geometryImage('jpeg');
  const references = [
    await uploadImage(p, target, png, 'image/png'),
    await uploadImage(p, target, jpeg, 'image/jpeg'),
  ];
  const answers: string[] = [];
  for (const [index, reference] of references.entries()) {
    const before = await p.service.native({ target });
    const request = {
      target,
      messageId: crypto.randomUUID(),
      images: [reference],
      body:
        index === 0
          ? "For this image and each image I send next, report only the left object's color and shape followed by the right object's color and shape, in English. Inspect the actual pixels. No tools, other messages or follow-up questions."
          : '',
    };
    await p.service.message(request);
    check((await p.service.message(request)).duplicate, 'Image message retry changed identity');
    answers.push(
      await completed(p, target, { generation: before.generation, sequence: before.sequence }),
    );
  }
  check(
    /red\s+circle/i.test(answers[0] ?? '') && /blue\s+square/i.test(answers[0] ?? ''),
    'PNG semantic vision mismatch',
  );
  check(
    /green\s+triangle/i.test(answers[1] ?? '') && /yellow\s+circle/i.test(answers[1] ?? ''),
    'JPEG image-only semantic vision mismatch',
  );
  await orderedImages(p, created, references);
  await orderedImages(p, created, [...references].reverse());
  const history = await p.service.history({ target, registrationGeneration, limit: 32 });
  check(
    references.every((ref) =>
      history.entries.some((row) => row.images.some((image) => image.digest === ref.digest)),
    ),
    'History lost image references',
  );
  const stream = await streamFrame(p, target);
  check(
    !stream.data.includes('data:image/') &&
      !stream.data.includes(join(p.machine.stateDir, 'attachments')),
    'Stream exposed private image input',
  );
  report('semantic-vision', {
    runtime: target.agent,
    model: created.modelSelection,
    png: answers[0],
    jpegImageOnly: answers[1],
    imageHashes: references.map((ref) => ref.digest),
    previewBytes: true,
    historyReferences: true,
    nativeStreamSafe: true,
  });
  return { references, bytes: [png, jpeg] };
}
async function largeImage(
  p: NativeImageProbe,
  created: Created,
  images: { references: AttachmentReference[]; bytes: Buffer[] },
) {
  const session = loadSessions(p.machine).find((row) => row.uuid === created.target.threadId);
  check(session, 'Large-image worker missing');
  const pid = readManagedRuntimeStatus(p.machine, session).snapshot?.pid;
  check(pid, 'Large-image worker PID missing');
  const rss = () =>
    Number(
      Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
        .stdout.toString()
        .trim(),
    );
  const beforeRss = rss();
  let peakRss = beforeRss,
    samples = 1;
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, rss());
    samples++;
  }, 250);
  try {
    const bytes = nearLimitImage(),
      reference = await uploadImage(p, created.target, bytes, 'image/png');
    const before = await p.service.native({ target: created.target });
    await p.service.message({
      target: created.target,
      messageId: crypto.randomUUID(),
      images: [reference],
      body: 'Describe only the texture of this new attached image, in one short sentence. Use no tools or other messages.',
    });
    await completed(p, created.target, {
      generation: before.generation,
      sequence: before.sequence,
    });
    const history = await p.service.history({
      target: created.target,
      registrationGeneration: created.registrationGeneration,
      limit: 64,
    });
    const historyBytes = Buffer.byteLength(JSON.stringify(history)),
      frame = await streamFrame(p, created.target);
    check(
      history.entries.some((row) => row.images.some((image) => image.digest === reference.digest)),
      'Large image history lost reference',
    );
    check(
      historyBytes < 384 * 1024 && Buffer.byteLength(frame.data) <= 512 * 1024,
      'Large image expanded native projection bounds',
    );
    check(!frame.data.includes('data:image/'), 'Large image body leaked into stream');
    images.references.push(reference);
    images.bytes.push(bytes);
    report('near-limit-opencode-image', {
      bytes: bytes.length,
      pixels: reference.width * reference.height,
      historyBytes,
      streamBytes: Buffer.byteLength(frame.data),
      sampledWorkerRssKiB: { before: beforeRss, peak: peakRss, samples, intervalMs: 250 },
      previewExact: true,
      historyReference: true,
    });
  } finally {
    clearInterval(timer);
  }
}
async function steering(p: NativeImageProbe, created: Created, image: AttachmentReference) {
  const { target, registrationGeneration } = created;
  await idle(p, target);
  const baseline = await p.service.native({ target });
  await p.service.message({
    target,
    messageId: crypto.randomUUID(),
    body: 'Use the shell tool once to run sleep 12, then reply ORIGINAL_MARKER. This is a bounded concurrency test. Do not edit files or contact other sessions.',
  });
  let frame = await p.service.native({ target });
  await until('active native tool', async () => {
    frame = await p.service.native({ target });
    return frame.baseline.some((row) => row.kind === 'tool' && row.status === 'started');
  });
  const active = await p.service.get({ target });
  check(active.turn?.status === 'inProgress', 'No active steer target');
  const input = {
    target,
    registrationGeneration,
    generation: frame.generation,
    expectedTurnId: active.turn.id,
    operationId: crypto.randomUUID(),
    body: 'Correction: after the tool returns, reply STEERED_MARKER instead of the original marker. Do not launch any further tools.',
  };
  const queuedId = crypto.randomUUID();
  await p.service.message({
    target,
    messageId: queuedId,
    body: 'Report the colors and shapes only, in English. No tools.',
    images: [image],
    defer: true,
  });
  await refusal(
    () => p.service.steer({ ...input, generation: crypto.randomUUID() }),
    'IDENTITY_MISMATCH',
  );
  const receipt = await p.service.steer(input);
  check(receipt.state === 'submitted', 'Native steer acceptance unresolved');
  check(
    (await p.service.steer(input)).clientUserMessageId === receipt.clientUserMessageId,
    'Steer duplicate identity changed',
  );
  const answer = await completed(p, target, {
    generation: baseline.generation,
    sequence: baseline.sequence,
  });
  check(answer.includes('STEERED_MARKER'), 'Original native turn ignored steering');
  const history = await p.service.history({ target, registrationGeneration, limit: 32 });
  check(
    history.entries.some(
      (row) =>
        row.turnId === receipt.turnId &&
        row.kind === 'assistant' &&
        row.text?.includes('STEERED_MARKER'),
    ),
    'Steered output moved to another turn',
  );
  check(
    (
      await p.service.steeringOperation({
        target,
        registrationGeneration,
        operationId: input.operationId,
      })
    ).operation?.state === 'submitted',
    'Steering receipt unavailable',
  );
  const beforeQuestion = await p.service.native({ target });
  await p.service.message({
    target,
    messageId: crypto.randomUUID(),
    body: 'Ask one native request_user_input question with exactly two choices Red and Blue. Wait for the answer and then say ANSWERED_MARKER. No other tools.',
  });
  let pendingFrame = await p.service.native({ target });
  await until('native pending input', async () => {
    pendingFrame = await p.service.native({ target });
    return pendingFrame.pending.some((row) => row.kind === 'input');
  });
  const pending = pendingFrame.pending.find((row) => row.kind === 'input');
  check(pending, 'Pending input vanished');
  await refusal(
    () =>
      p.service.steer({
        ...input,
        generation: pendingFrame.generation,
        expectedTurnId: pending.turnId,
        operationId: crypto.randomUUID(),
      }),
    'BUSY',
  );
  await p.service.respond({
    target,
    generation: pendingFrame.generation,
    operationId: crypto.randomUUID(),
    requestId: pending.requestId,
    kind: 'input',
    answers: Object.fromEntries(
      pending.questions.map((question) => [question.id, [question.options?.[0]?.label ?? 'Red']]),
    ),
  });
  check(
    (
      await completed(p, target, {
        generation: beforeQuestion.generation,
        sequence: beforeQuestion.sequence,
      })
    ).includes('ANSWERED_MARKER'),
    'Exact input response failed',
  );
  report('exact-turn-steering', {
    turnId: receipt.turnId,
    clientUserMessageId: receipt.clientUserMessageId,
    state: receipt.state,
    duplicate: true,
    staleGenerationRefused: true,
    pendingInputRefused: true,
    deferredImagePreserved: true,
  });
}
async function restart(
  p: NativeImageProbe,
  created: Created,
  images: { references: AttachmentReference[]; bytes: Buffer[] },
) {
  const session = loadSessions(p.machine).find((row) => row.uuid === created.target.threadId);
  check(session, 'Managed identity missing');
  const before = readManagedRuntimeStatus(p.machine, session).snapshot;
  check(before, 'Restart baseline missing');
  await killSession(p.machine, session.name);
  await p.service.start({ target: created.target });
  await until('provider restart', async () => {
    const next = readManagedRuntimeStatus(p.machine, session).snapshot;
    return next !== null && next.generation !== before.generation && next.state === 'idle';
  });
  const after = readManagedRuntimeStatus(p.machine, session).snapshot;
  check(after?.threadId === before.threadId, 'Restart changed managed identity');
  check(
    after.nativeSession?.id === before.nativeSession?.id,
    'Restart changed provider continuation',
  );
  const history = await p.service.history({
    target: created.target,
    registrationGeneration: created.registrationGeneration,
    limit: 64,
  });
  for (const [index, reference] of images.references.entries()) {
    const bytes = images.bytes[index];
    check(bytes, 'Fixture bytes missing');
    await previewImage(p, created.target, reference, bytes);
    check(
      history.entries.some((row) => row.images.some((image) => image.digest === reference.digest)),
      'Restart lost image reachability',
    );
  }
  report('restart-history', {
    runtime: created.target.agent,
    identityHash: sha(created.target.threadId),
    generationChanged: true,
    continuationStable: true,
    references: images.references.length,
    previewBytesStable: true,
  });
}

const p = await nativeImageProbe();
try {
  report('isolated-probe', { root: p.root });
  const codexModels = await modelCatalog(p, 'codex');
  const nativeModel =
    codexModels.find((row) => row.id === 'gpt-5.6-luna' && row.inputModalities.includes('image')) ??
    codexModels.find((row) => row.inputModalities.includes('image'));
  check(nativeModel, 'No native vision model');
  const openModels = await modelCatalog(p, 'opencode');
  const visionModels = openModels.filter(
    (row) => row.provider === 'openrouter' && row.inputModalities.includes('image'),
  );
  const openModel =
    visionModels.find((row) => row.id === 'google/gemini-2.5-flash') ??
    visionModels.find((row) => row.id === 'openai/gpt-4.1-mini') ??
    visionModels[0];
  check(openModel, 'No configured OpenCode vision lane');
  const created: Created[] = [];
  for (const runtime of ['codex', 'opencode'] satisfies Array<'codex' | 'opencode'>) {
    const request = {
      requestId: crypto.randomUUID(),
      name: `${runtime}-vision`,
      workspace: join(p.root, runtime),
      runtime,
      modelSelection:
        runtime === 'codex'
          ? { provider: 'openai', model: nativeModel.model ?? nativeModel.id }
          : { provider: 'openrouter', model: openModel.model ?? openModel.id },
      ...(runtime === 'codex' ? { launchRecipe: { id: 'native', revision: '1' } } : {}),
    };
    const receipt = await p.service.create(request);
    created.push(receipt);
    const retry = await p.service.create(request);
    check(
      retry.duplicate && retry.target.threadId === receipt.target.threadId,
      'Create duplicate spawned another writer',
    );
  }
  check(loadSessions(p.machine).length === 2, 'Expected exactly two isolated managed runtimes');
  const codex = created[0],
    opencode = created[1];
  check(codex && opencode, 'Two native fixtures required');
  await idle(p, codex.target);
  await idle(p, opencode.target);
  const writerPids = loadSessions(p.machine).map(
    (row) => readManagedRuntimeStatus(p.machine, row).snapshot?.providerPid,
  );
  check(
    writerPids.every((pid) => pid !== undefined) && new Set(writerPids).size === 2,
    'Native writer cardinality differs from two',
  );
  report('two-native-writers', {
    writerPids,
    models: created.map((row) => row.modelSelection),
    duplicateCreate: true,
  });
  const codexImages = await vision(p, codex),
    openImages = await vision(p, opencode);
  await largeImage(p, opencode, openImages);
  const openFrame = await p.service.native({ target: opencode.target }),
    openRow = await p.service.get({ target: opencode.target });
  const openTurn = openRow.turn;
  check(openTurn, 'Native OpenCode turn evidence missing');
  await refusal(
    () =>
      p.service.steer({
        target: opencode.target,
        registrationGeneration: opencode.registrationGeneration,
        generation: openFrame.generation,
        expectedTurnId: openTurn.id,
        operationId: crypto.randomUUID(),
        body: 'No-op unsupported probe.',
      }),
    'UNSUPPORTED',
  );
  report('opencode-steering', { exactTurnCAS: 'unsupported', rejectedBeforeSubmission: true });
  const unsupported = openModels.find(
    (row) => row.provider === 'openrouter' && !row.inputModalities.includes('image'),
  );
  const firstImage = openImages.references[0];
  check(unsupported && firstImage, 'Unsupported-modality fixture unavailable');
  const before = loadLedger(p.machine).length;
  await refusal(
    () =>
      p.service.message({
        target: opencode.target,
        messageId: crypto.randomUUID(),
        body: 'Describe this image.',
        images: [firstImage],
        options: {
          runtime: 'opencode',
          model: { provider: 'openrouter', model: unsupported.model ?? unsupported.id },
        },
      }),
    'UNSUPPORTED',
  );
  check(loadLedger(p.machine).length === before, 'Unsupported image entered the ledger');
  const image = codexImages.references[0];
  check(image, 'PNG fixture missing');
  await steering(p, codex, image);
  await restart(p, codex, codexImages);
  await restart(p, opencode, openImages);
  const providers = loadSessions(p.machine).map(
    (row) => readManagedRuntimeStatus(p.machine, row).snapshot?.providerPid,
  );
  await p.restartDaemon();
  check(
    loadSessions(p.machine).every(
      (row, index) =>
        readManagedRuntimeStatus(p.machine, row).snapshot?.providerPid === providers[index],
    ),
    'Daemon restart replaced native writer',
  );
  report('complete', {
    runtimes: 2,
    semanticVision: true,
    imageOnly: true,
    orderedMultipleImages: true,
    reversedOrderSameIdRefused: true,
    previewExact: true,
    modelRefusalBeforeLedger: true,
    exactSteering: true,
    providerRestart: true,
    daemonRestartOneWriter: true,
  });
} finally {
  await p.cleanup();
  report('evidence-directory', { root: p.root });
}
