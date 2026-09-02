import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseNDJSON } from 'stitchkit';
import { createApplication, managedServerResource } from 'stitchkit/application';
import { ContractStreamFrameSchema } from 'stitchkit/contract';
import { z } from 'zod';
import { ownedCodexSocket, privateRuntimeDirectory } from '../src/agent/codex/ownedPaths.ts';
import { OwnedCodexProjection } from '../src/agent/codex/ownedProjection.ts';
import { OwnedCodexStatusWriter } from '../src/agent/codex/ownedStatus.ts';
import { writePrivateJson } from '../src/attachments/files.ts';
import { ATTACHMENT_LIMITS } from '../src/attachments/reference.ts';
import { beginAttachmentUpload } from '../src/attachments/service.ts';
import { rowFromLedgerRecord } from '../src/chat/fleetLog.ts';
import { formatChatInjection } from '../src/chat/format.ts';
import { managedPeer, managedPeerKey, servicePrincipal } from '../src/chat/identity.ts';
import {
  MESSAGE_OPERATION_LIMITS,
  MessageOperationJournalSchema,
} from '../src/chat/messageOperationSchema.ts';
import {
  advanceMessageOperation,
  prepareMessageOperation,
  readMessageJournal,
} from '../src/chat/messageOperationStore.ts';
import { principalOrigin } from '../src/chat/origin.ts';
import { chatPaths, loadLedger } from '../src/chat/store.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/config/sessions.ts';
import { ContentBuffer } from '../src/content/buffer.ts';
import { ContentWriter } from '../src/content/store.ts';
import { createControlClient } from '../src/control/client.ts';
import { acceptControlMessage } from '../src/control/message.ts';
import {
  ControlNativeStreamFrameSchema,
  encodeControlNativeStreamCursor,
  readControlNativeStreamCursor,
} from '../src/control/nativeStreamContract.ts';
import { controlSocket } from '../src/control/path.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { type ControlMessage, ControlNativeSnapshotSchema } from '../src/control/schema.ts';
import { createControlServer } from '../src/control/server.ts';
import {
  CCMUX_CONTROL_SERVICE_INGRESS_PATH,
  CCMUX_CONTROL_SERVICE_PREFIX,
  CCMUX_CONTROL_SERVICE_REVISION,
  ControlServiceDescriptorSchema,
  ControlServiceOperationSchema,
  ccmuxControlServiceDescriptor,
  createCcmuxControlServiceClient,
} from '../src/control/serviceDescriptor.ts';
import { UNSEEN } from '../src/events/observe.ts';
import { ExternalStatusPublisher } from '../src/external/resident-publisher.ts';
import { MonitoringPublisher } from '../src/monitoring/publish.ts';
import { NATIVE_RUNTIME_TTL_MS } from '../src/runtime/projectionSchema.ts';
import { managedRuntimeRoot } from '../src/runtime/status.ts';
import { digest, imageBytes } from './attachments-fixture.test.ts';
import { makeCli, makeMachine, makeSession } from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function catalogFixture(socket: string) {
  privateRuntimeDirectory(dirname(socket));
  const RequestSchema = z
    .object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() })
    .passthrough();
  return Bun.serve({
    unix: socket,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, value) {
        const request = RequestSchema.parse(JSON.parse(String(value)));
        if (request.id === undefined) return;
        const result =
          request.method === 'initialize'
            ? { userAgent: 'codex/0.147.0' }
            : request.method === 'config/read'
              ? { config: { model_provider: 'openai' } }
              : {
                  data: ['model-a', 'model-b'].map((id) => ({
                    id,
                    model: id,
                    displayName: id,
                    description: 'fixture',
                    hidden: false,
                    isDefault: id === 'model-a',
                    inputModalities: ['text', 'image'],
                    serviceTiers: [],
                    supportedReasoningEfforts: [
                      { reasoningEffort: 'medium', description: 'fixture' },
                    ],
                    defaultReasoningEffort: 'medium',
                  })),
                  nextCursor: null,
                };
        ws.send(JSON.stringify({ id: request.id, result }));
      },
    },
  });
}

async function fixture(options: { launchRecipe?: boolean } = {}) {
  const root = mkdtempSync('/tmp/ccmux-service-test-');
  const recipeEnvFile = join(root, 'provider.env');
  const recipeSecret = 'fixture-service-secret-never-public';
  if (options.launchRecipe) writeFileSync(recipeEnvFile, `MODEL_SERVICE_TOKEN=${recipeSecret}\n`);
  const machine = makeMachine({
    messageApplications: {
      'sample-app': {
        revision: 'r1',
        callers: ['host-b'],
        channels: ['chat'],
        actors: ['human', 'agent'],
        ownerNotifications: false,
      },
    },
    stateDir: root,
    rcPrefix: 'host-a',
    projectsDir: join(root, 'history'),
    chatEnabled: true,
    codexHome: join(root, 'codex'),
    codexSessionsDir: join(root, 'codex', 'sessions'),
    ...(options.launchRecipe
      ? {
          launchRecipes: {
            'provider-a': {
              revision: 'r1',
              envFile: recipeEnvFile,
              flags: [
                '-c',
                'model_provider="provider-a"',
                '-c',
                'model_providers.provider-a.name="Provider A"',
                '-c',
                'model_providers.provider-a.base_url="https://api.example.invalid/v1"',
                '-c',
                'model_providers.provider-a.env_key="MODEL_SERVICE_TOKEN"',
              ],
              environment: ['MODEL_SERVICE_TOKEN'],
              capabilities: ['external-provider'],
            },
          },
        }
      : {}),
  });
  const session = makeSession({
    name: 'agent-a',
    dir: root,
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: crypto.randomUUID(),
    modelSelection: { provider: 'openai', model: 'model-a' },
    chatEnabled: true,
  });
  await writeSessionsUnlocked(machine, [session]);
  const native = new OwnedCodexProjection(machine, session, process.pid);
  native.reconcile({ type: 'idle' }, 0);
  native.event({
    method: 'item/completed',
    params: {
      threadId: session.uuid,
      turnId: 'turn-a',
      item: { id: 'assistant-a', type: 'agentMessage', text: 'ready' },
    },
  });
  const writer = new OwnedCodexStatusWriter(machine, session.name);
  await writer.write(native.snapshot());
  const content = new ContentBuffer(machine, session, native.snapshot().generation);
  content.text('assistant', 'turn-a', 'assistant-a', 'ready', 'replace', true);
  const contentWriter = new ContentWriter(machine, session);
  contentWriter.offer(() => content.snapshot());
  await contentWriter.flush();
  const provider = catalogFixture(ownedCodexSocket(machine, session.name));
  const publisher = new ControlPublisher(machine);
  const monitoring = new MonitoringPublisher();
  const publish = async () => {
    monitoring.begin(machine);
    monitoring.sample(machine, session, 1, '❯\n? for shortcuts', UNSEEN);
    publisher.publish(machine, await monitoring.publish(machine));
  };
  await publish();
  let createCalls = 0;
  const owned = createControlServer(
    machine,
    publisher,
    undefined,
    () => machine,
    new ExternalStatusPublisher(machine.rcPrefix),
    {
      createManagedSession: async (_current, input) => {
        createCalls++;
        await Bun.sleep(10);
        const created = makeSession({
          name: input.name,
          dir: input.dir,
          uuid: crypto.randomUUID(),
          agent: 'codex',
          runtime: 'app-server',
          registrationGeneration: input.registrationGeneration,
          chatEnabled: true,
          flags: input.flags,
          envFile: input.envFile,
          launchRecipe: input.launchRecipe,
        });
        await writeSessionsUnlocked(machine, [...loadSessions(machine), created]);
        return created;
      },
    },
  );
  const socket = controlSocket(machine);
  const local = createControlClient({ socket });
  const servicePayloads: string[] = [];
  const remote = createCcmuxControlServiceClient(async (url, init) => {
    const route = new URL(String(url));
    const operation = ControlServiceOperationSchema.parse(
      route.pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
    );
    const payload = typeof init?.body === 'string' ? init.body : '{}';
    servicePayloads.push(payload);
    return fetch(`http://ccmux.local${CCMUX_CONTROL_SERVICE_INGRESS_PATH}`, {
      unix: socket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        id: crypto.randomUUID(),
        caller: 'host-b',
        service: 'ccmux.control',
        revision: CCMUX_CONTROL_SERVICE_REVISION,
        operation,
        payload,
      }),
    });
  });
  const target = managedPeer(machine.rcPrefix, session);
  cleanup.push(async () => {
    await local.close();
    await contentWriter.close();
    await provider.stop(true);
    publisher.close();
    owned.external.close();
    await owned.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await owned.observability.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    machine,
    session,
    native,
    writer,
    publisher,
    publish,
    owned,
    socket,
    local,
    remote,
    target,
    recipeEnvFile,
    recipeSecret,
    servicePayloads,
    createCalls: () => createCalls,
  };
}

test('declared service activates a host-owned recipe without carrying its environment source or value', async () => {
  const f = await fixture({ launchRecipe: true });
  const receipt = await f.remote.create({
    requestId: crypto.randomUUID(),
    name: 'recipe-a',
    workspace: f.root,
    flags: [],
    launchRecipe: { id: 'provider-a', revision: 'r1' },
  });
  expect(receipt.launchRecipe).toMatchObject({
    id: 'provider-a',
    revision: 'r1',
    capabilities: ['external-provider'],
  });
  const wire = f.servicePayloads.at(-1) ?? '';
  expect(wire).not.toContain(f.recipeSecret);
  expect(wire).not.toContain(f.recipeEnvFile);
  expect(JSON.stringify(receipt)).not.toContain(f.recipeSecret);
  expect(JSON.stringify(receipt)).not.toContain(f.recipeEnvFile);
  expect(f.createCalls()).toBe(1);
});

test('declared message operation is caller-scoped and correlates identical-text submissions exactly', async () => {
  const f = await fixture();
  const registrationGeneration = f.session.registrationGeneration;
  if (!registrationGeneration) throw new Error('missing registration');
  const first = { target: f.target, messageId: crypto.randomUUID(), body: 'same text' };
  const second = { ...first, messageId: crypto.randomUUID(), defer: true };
  await f.remote.message(first);
  await f.remote.message(second);
  const read = { ...first, registrationGeneration };
  const selector = { target: read.target, messageId: read.messageId, registrationGeneration };
  expect((await f.remote.messageOperation(selector)).evidence?.state).toBe('queued');
  expect((await f.local.messageOperation(selector)).outcome).toBe('unavailable');
  advanceMessageOperation(f.machine, f.session, first.messageId, 'completed', 'turn-exact');
  const result = await f.remote.messageOperation(selector);
  expect(result.evidence).toMatchObject({ state: 'completed', turnId: 'turn-exact' });
  expect(
    (await f.remote.messageOperation({ ...selector, messageId: second.messageId })).evidence,
  ).toMatchObject({ state: 'queued', turnId: null });
  expect((await f.remote.message(first)).duplicate).toBe(true);
  expect(await f.remote.messageOperation(selector)).toEqual(result);
  expect(loadLedger(f.machine).filter((row) => row?.id === first.messageId)).toHaveLength(1);
});

test('full pending receipt capacity refuses before durable queue admission', async () => {
  const f = await fixture();
  prepareMessageOperation(
    f.machine,
    f.session,
    makeCli('host-b'),
    crypto.randomUUID(),
    'a'.repeat(64),
  );
  const journal = readMessageJournal(f.machine, f.session);
  const record = journal?.records[0];
  if (!journal || !record) throw new Error('missing prepared receipt fixture');
  // Fill the persisted boundary once. Replaying 256 whole-journal transactions measures fixture
  // disk speed, not the admission refusal under test, and exhausted the CI test deadline.
  journal.records = Array.from({ length: MESSAGE_OPERATION_LIMITS.records }, () => ({
    ...record,
    messageId: crypto.randomUUID(),
  }));
  writePrivateJson(
    managedRuntimeRoot(f.machine, f.session),
    'message-receipts.json',
    MessageOperationJournalSchema.parse(journal),
  );
  expect(readMessageJournal(f.machine, f.session)?.records).toHaveLength(
    MESSAGE_OPERATION_LIMITS.records,
  );
  const messageId = crypto.randomUUID();
  await expect(
    f.remote.message({ target: f.target, messageId, body: 'capacity probe' }),
  ).rejects.toMatchObject({ code: 'CAPACITY' });
  expect(loadLedger(f.machine).some((row) => row?.id === messageId)).toBe(false);
  expect(readMessageJournal(f.machine, f.session)).toEqual(journal);
});

test('current declared service exposes revisioned selection and image upload without a second ingress', async () => {
  const f = await fixture();
  const registrationGeneration = f.session.registrationGeneration;
  if (registrationGeneration === undefined) throw new Error('fixture registration missing');
  const selection = await f.remote.selection({ target: f.target, registrationGeneration });
  expect(selection.current).toMatchObject({
    revision: 0,
    options: { model: { model: 'model-a' }, mode: 'default' },
  });
  const change = {
    target: f.target,
    registrationGeneration,
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    options: {
      runtime: 'codex',
      model: { provider: 'openai', model: 'model-b' },
      mode: 'plan',
      effort: 'medium',
    },
  };
  const changed = await f.remote.select({
    ...change,
    options: { ...change.options, runtime: 'codex', mode: 'plan', effort: 'medium' },
  });
  expect(changed.current).toMatchObject({
    revision: 1,
    options: { model: { model: 'model-b' }, mode: 'plan' },
  });
  expect(
    await f.remote.select({
      ...change,
      options: { ...change.options, runtime: 'codex', mode: 'plan', effort: 'medium' },
    }),
  ).toEqual(changed);

  const bytes = imageBytes('png', 320, 240, true),
    uploadId = crypto.randomUUID();
  const begin = await f.remote.attachmentBegin({
    target: f.target,
    uploadId,
    mediaType: 'image/png',
    totalBytes: bytes.length,
    digest: digest(bytes),
  });
  expect(begin.receivedBytes).toBe(0);
  for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_LIMITS.chunkBytes) {
    const receipt = await f.remote.attachmentChunk({
      target: f.target,
      uploadId,
      offset,
      data: bytes.subarray(offset, offset + ATTACHMENT_LIMITS.chunkBytes).toString('base64'),
    });
    expect(receipt.receivedBytes).toBe(
      Math.min(bytes.length, offset + ATTACHMENT_LIMITS.chunkBytes),
    );
  }
  const reference = await f.remote.attachmentFinalize({ target: f.target, uploadId });
  expect(reference).toMatchObject({ id: uploadId, digest: digest(bytes), width: 320, height: 240 });
  const preview = await f.remote.attachmentRead({ target: f.target, reference, offset: 0 });
  expect(Buffer.from(preview.data, 'base64')).toEqual(
    bytes.subarray(0, ATTACHMENT_LIMITS.chunkBytes),
  );
  await expect(
    f.local.attachmentRead({ target: f.target, reference, offset: 0 }),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' });
  const messageId = crypto.randomUUID();
  expect(await f.remote.message({ target: f.target, messageId, images: [reference] })).toEqual({
    messageId,
    accepted: true,
    origin: principalOrigin(servicePrincipal('host-b', 'declared-service')),
    notification: 'conversation',
    registrationGeneration: f.session.registrationGeneration ?? null,
    duplicate: false,
    turnOptions: changed.current,
  });
  expect(await f.remote.message({ target: f.target, messageId, images: [reference] })).toEqual({
    messageId,
    accepted: true,
    origin: principalOrigin(servicePrincipal('host-b', 'declared-service')),
    notification: 'conversation',
    registrationGeneration: f.session.registrationGeneration ?? null,
    duplicate: true,
    turnOptions: changed.current,
  });
  expect(loadLedger(f.machine)[0]).toMatchObject({
    body: '',
    images: [reference],
    turnOptions: changed.current,
  });
  await expect(f.remote.attachmentCancel({ target: f.target, uploadId })).rejects.toMatchObject({
    code: 'ATTACHMENT_UNAVAILABLE',
  });
  expect(
    f.servicePayloads
      .filter((payload) => payload.includes('"images"'))
      .every((payload) => Buffer.byteLength(payload) < 32 * 1024),
  ).toBe(true);
  expect(
    (
      await fetch('http://ccmux.local/ccmux-control/v1/invoke', {
        unix: f.socket,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(404);
});

test('application attribution is host-bound, generation-pinned, durable and part of retry identity', async () => {
  const f = await fixture();
  const input = {
    target: f.target,
    registrationGeneration: z.uuid().parse(f.session.registrationGeneration),
    messageId: crypto.randomUUID(),
    body: 'application conversation',
    origin: { applicationId: 'sample-app', channelId: 'chat', actor: 'human' },
  } satisfies ControlMessage;
  await expect(
    f.remote.message({ ...input, origin: { ...input.origin, applicationId: 'forged' } }),
  ).rejects.toMatchObject({ code: 'ORIGIN_REFUSED' });
  await expect(
    f.remote.message({ ...input, origin: { ...input.origin, channelId: 'wrong' } }),
  ).rejects.toMatchObject({ code: 'ORIGIN_REFUSED' });
  await expect(f.local.message(input)).rejects.toMatchObject({ code: 'ORIGIN_REFUSED' });
  await expect(f.remote.message({ ...input, notification: 'owner' })).rejects.toMatchObject({
    code: 'ORIGIN_REFUSED',
  });
  await expect(
    f.remote.message({ ...input, registrationGeneration: crypto.randomUUID() }),
  ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  expect(loadLedger(f.machine)).toHaveLength(0);
  const first = await f.remote.message(input);
  expect(first).toMatchObject({
    notification: 'conversation',
    registrationGeneration: input.registrationGeneration,
    origin: {
      ingress: 'service',
      actor: 'human',
      assurance: 'application-attested',
      application: { applicationId: 'sample-app', channelId: 'chat', revision: 'r1' },
    },
  });
  expect(await f.remote.message(input)).toEqual({ ...first, duplicate: true });
  await expect(
    f.remote.message({ ...input, origin: { ...input.origin, actor: 'agent' } }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(f.remote.message({ ...input, body: 'changed' })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const row = loadLedger(f.machine)[0];
  if (!row) throw new Error('missing accepted message');
  const framing = formatChatInjection(row);
  expect(framing).toContain('application input via ccmux/service');
  expect(framing).toContain('not independently authenticated');
  expect(framing).not.toContain('cli');
  expect(rowFromLedgerRecord('host-a', row)).toMatchObject({
    messageId: input.messageId,
    origin: first.origin,
    notification: 'conversation',
    sender: row.from,
    target: f.target,
  });
  const second = await f.remote.message({ ...input, messageId: crypto.randomUUID() });
  expect(second.messageId).not.toBe(first.messageId);
  expect(loadLedger(f.machine)).toHaveLength(2);
  const binding = f.machine.messageApplications['sample-app'];
  if (!binding) throw new Error('missing binding');
  binding.channels.push('other');
  await expect(
    f.remote.message({ ...input, origin: { ...input.origin, channelId: 'other' } }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  binding.revision = 'r2';
  await expect(f.remote.message(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(loadLedger(f.machine)[0]?.origin).toEqual(first.origin);
  expect(loadLedger(f.machine)).toHaveLength(2);
});

test('pre-cutover machine-owned uploads remain usable by the current service and retained input', async () => {
  const f = await fixture();
  const bytes = imageBytes('png', 10, 10, true);
  const uploadId = crypto.randomUUID();
  await beginAttachmentUpload(
    f.machine,
    makeCli('host-b'),
    {
      target: f.target,
      uploadId,
      mediaType: 'image/png',
      totalBytes: bytes.length,
      digest: digest(bytes),
    },
    new AbortController().signal,
  );
  await f.remote.attachmentChunk({
    target: f.target,
    uploadId,
    offset: 0,
    data: bytes.toString('base64'),
  });
  const reference = await f.remote.attachmentFinalize({ target: f.target, uploadId });
  const input = {
    target: f.target,
    registrationGeneration: z.uuid().parse(f.session.registrationGeneration),
    messageId: crypto.randomUUID(),
    images: [reference],
    origin: { applicationId: 'sample-app', channelId: 'chat', actor: 'human' },
  } satisfies ControlMessage;
  const receipt = await f.remote.message(input);
  expect(receipt.accepted).toBe(true);
  expect((await f.remote.message(input)).duplicate).toBe(true);
  expect(
    Buffer.from(
      (await f.remote.attachmentRead({ target: f.target, reference, offset: 0 })).data,
      'base64',
    ),
  ).toEqual(bytes);
  expect(loadLedger(f.machine)).toHaveLength(1);
});

test('accepted historical machine input and image pins survive the ingress cutover without reattribution', async () => {
  const f = await fixture();
  const bytes = imageBytes('png', 10, 10, true);
  const uploadId = crypto.randomUUID();
  await beginAttachmentUpload(
    f.machine,
    makeCli('host-b'),
    {
      target: f.target,
      uploadId,
      mediaType: 'image/png',
      totalBytes: bytes.length,
      digest: digest(bytes),
    },
    new AbortController().signal,
  );
  await f.remote.attachmentChunk({
    target: f.target,
    uploadId,
    offset: 0,
    data: bytes.toString('base64'),
  });
  const reference = await f.remote.attachmentFinalize({ target: f.target, uploadId });
  const input = {
    target: f.target,
    messageId: crypto.randomUUID(),
    images: [reference],
    body: 'accepted before upgrade',
    defer: true,
  };
  await acceptControlMessage(f.machine, makeCli('host-b'), input, new AbortController().signal);
  const old = loadLedger(f.machine)[0];
  if (!old) throw new Error('missing historical fixture');
  delete old.origin;
  delete old.notification;
  delete old.registrationGeneration;
  writeFileSync(chatPaths(f.machine).ledger, `${JSON.stringify(old)}\n`);
  const retry = await f.remote.message(input);
  expect(retry).toMatchObject({
    duplicate: true,
    notification: 'conversation',
    origin: { ingress: 'unknown', actor: 'unknown', assurance: 'unknown' },
    registrationGeneration: null,
  });
  const operation = await f.remote.messageOperation({
    target: f.target,
    messageId: input.messageId,
    registrationGeneration: z.uuid().parse(f.session.registrationGeneration),
  });
  expect(operation.evidence?.state).toBe('queued');
  expect(
    Buffer.from(
      (await f.remote.attachmentRead({ target: f.target, reference, offset: 0 })).data,
      'base64',
    ),
  ).toEqual(bytes);
  expect(loadLedger(f.machine)).toHaveLength(1);
  expect(loadLedger(f.machine)[0]?.origin).toBeUndefined();
});

test('declared service reuses exact control operations, identity and admission', async () => {
  const f = await fixture();
  expect(await f.remote.get({ target: f.target })).toEqual(await f.local.get({ target: f.target }));
  expect(await f.remote.native({ target: f.target, cursor: null })).toEqual(
    await f.local.native({ target: f.target, cursor: null }),
  );
  const messageId = crypto.randomUUID();
  expect(await f.remote.message({ target: f.target, messageId, body: 'service message' })).toEqual({
    messageId,
    accepted: true,
    origin: principalOrigin(servicePrincipal('host-b', 'declared-service')),
    notification: 'conversation',
    registrationGeneration: f.session.registrationGeneration ?? null,
    duplicate: false,
    turnOptions: (
      await f.remote.selection({
        target: f.target,
        registrationGeneration: z.uuid().parse(f.session.registrationGeneration),
      })
    ).current,
  });
  expect(await f.remote.message({ target: f.target, messageId, body: 'service message' })).toEqual({
    messageId,
    accepted: true,
    origin: principalOrigin(servicePrincipal('host-b', 'declared-service')),
    notification: 'conversation',
    registrationGeneration: f.session.registrationGeneration ?? null,
    duplicate: true,
    turnOptions: (
      await f.remote.selection({
        target: f.target,
        registrationGeneration: z.uuid().parse(f.session.registrationGeneration),
      })
    ).current,
  });
  expect(loadLedger(f.machine)).toHaveLength(1);
  expect(loadLedger(f.machine)[0]?.from).toEqual({
    kind: 'service',
    transport: 'declared-service',
    source: 'ccmux',
    machine: 'host-b',
  });
  const requestId = crypto.randomUUID();
  const firstCreate = f.remote.create({
    requestId,
    name: 'created-a',
    workspace: f.root,
    flags: [],
  });
  // Wait for the first create to actually be in flight, generously: this is a precondition, not a
  // measurement. Fifty milliseconds was enough on an idle machine and not on a loaded one, and the
  // failure read as "concurrent create was not refused" when the truth was "there was nothing to
  // be concurrent with yet".
  for (
    let attempt = 0;
    attempt < 5_000 && f.owned.controls.mutations.getSnapshot().active === 0;
    attempt++
  )
    await Bun.sleep(1);
  expect(f.owned.controls.mutations.getSnapshot().active).toBeGreaterThan(0);
  // Two truthful answers, and which one is owed depends on the RECEIPT, not on the clock. While the
  // create is unsettled a second one is a race and is refused; once the receipt is complete the
  // same request id is answered from it — a caller whose first answer was lost to a transport must
  // be able to tell "already done" from "still running", and BUSY says neither. The receipt is read
  // here rather than assumed, because the work can finish while the admission slot is still counted.
  //
  // Which of the two is owed cannot be pinned from out here. Reading the receipt first and then
  // asserting on that reading is a race with a slow name: the work can settle in the gap between
  // the read and the retry, and then the test demands BUSY from a request that is correctly
  // answered from a complete receipt. It failed exactly that way on a loaded machine.
  //
  // So the assertion is what holds in BOTH cases and is not vacuous: a retry of a request id
  // already in flight is answered truthfully — refused as BUSY, or answered from the receipt — and
  // never any third thing. That it never produces a SECOND creation is carried by `createCalls()`
  // below, and the settled case is pinned deterministically there too, after the first create has
  // certainly finished.
  const retry = await f.remote
    .create({ requestId, name: 'created-a', workspace: f.root, flags: [] })
    .then((value) => ({ kind: 'answered' as const, value }))
    .catch((error: unknown) => ({ kind: 'refused' as const, error }));
  if (retry.kind === 'refused') expect(retry.error).toMatchObject({ code: 'BUSY', status: 429 });
  else expect(retry.value.duplicate).toBe(true);
  const created = await firstCreate;
  const duplicate = await f.remote.create({
    requestId,
    name: 'created-a',
    workspace: f.root,
    flags: [],
  });
  expect(f.createCalls()).toBe(1);
  expect(created.target).toEqual(duplicate.target);
  expect([created.duplicate, duplicate.duplicate].sort()).toEqual([false, true]);
  f.owned.controls.mutations.stopAdmission();
  await expect(
    f.remote.message({ target: f.target, messageId: crypto.randomUUID(), body: 'after drain' }),
  ).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
});

test('service envelope, effect, nested selector, size and stale identity fail closed', async () => {
  const f = await fixture();
  const invoke = (body: unknown) =>
    fetch(`http://ccmux.local${CCMUX_CONTROL_SERVICE_INGRESS_PATH}`, {
      unix: f.socket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const base = {
    v: 1,
    id: crypto.randomUUID(),
    caller: 'host-b',
    service: 'ccmux.control',
    revision: CCMUX_CONTROL_SERVICE_REVISION,
    operation: 'session.get',
    payload: JSON.stringify({ target: f.target }),
  };
  expect((await invoke({ ...base, revision: '1' })).status).toBe(400);
  expect((await invoke({ ...base, revision: '2' })).status).toBe(400);
  for (const version of ['1', '2', '3']) {
    expect(
      (
        await fetch(`http://ccmux.local/ccmux-control/v${version}/invoke`, {
          unix: f.socket,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(base),
        })
      ).status,
    ).toBe(404);
  }
  expect((await invoke({ ...base, operation: 'unknown' })).status).toBe(400);
  expect(
    (
      await invoke({
        ...base,
        payload: JSON.stringify({ target: f.target, operation: 'session.archive' }),
      })
    ).status,
  ).toBe(400);
  expect((await invoke({ ...base, payload: 'x'.repeat(70_000) })).status).toBe(400);
  expect(() =>
    ControlServiceDescriptorSchema.parse({
      ...ccmuxControlServiceDescriptor,
      operations: ccmuxControlServiceDescriptor.operations.map((operation) =>
        operation.id === 'session.get' ? { ...operation, effect: 'session.create' } : operation,
      ),
    }),
  ).toThrow('wrong effect');

  f.native.request({
    id: 'approval-a',
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: f.session.uuid,
      turnId: 'turn-a',
      itemId: 'tool-a',
      startedAtMs: Date.now(),
      reason: 'confirm',
      availableDecisions: ['accept', 'decline'],
    },
  });
  await f.writer.write(f.native.snapshot());
  await f.publish();
  await expect(
    f.remote.respond({
      target: f.target,
      operationId: crypto.randomUUID(),
      generation: crypto.randomUUID(),
      requestId: 's:approval-a',
      kind: 'approval',
      decision: 'decline',
      answers: null,
    }),
  ).rejects.toMatchObject({ code: 'STALE_REQUEST', status: 409 });
});

test('managed shutdown drains an open native stream before closing control', async () => {
  const f = await fixture();
  const application = createApplication({
    id: 'native-stream-shutdown',
    resources: [managedServerResource({ id: 'control', server: f.owned.server })],
    shutdown: { gracePeriodMs: 100, forceTimeoutMs: 200 },
  });
  await application.start();
  const clientAbort = new AbortController();
  const response = await fetch('http://ccmux.local/control-events/native', {
    unix: f.socket,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: f.target, cursor: null }),
    signal: clientAbort.signal,
  });
  const frames = parseNDJSON<unknown>(response)[Symbol.asyncIterator]();
  try {
    expect(response.status).toBe(200);
    const first = await frames.next();
    expect(first.done).toBe(false);
    const frame = ContractStreamFrameSchema.parse(first.value);
    if (frame.type !== 'data') throw new Error('Expected a native data frame');
    const snapshot = ControlNativeSnapshotSchema.parse(frame.data);
    expect(snapshot.target).toEqual(f.target);
    expect(snapshot.registrationGeneration).toBe(f.session.registrationGeneration ?? null);

    // Keep the client subscribed: cancellation belongs to the managed server resource.
    const result = await application.shutdown();
    expect(result.cleanupComplete).toBe(true);
    expect(result.outcome).toBe('clean');
    expect(f.owned.server.status.pendingRequests).toBe(0);
    expect((await frames.next()).done).toBe(true);
    expect(clientAbort.signal.aborted).toBe(false);
    expect(loadSessions(f.machine)).toEqual([f.session]);
  } finally {
    clientAbort.abort();
    await frames.return(undefined);
  }
});

test('native stream cursor binds target and source adapter resumes, heartbeats and cancels', async () => {
  const f = await fixture();
  const config = join(f.root, 'machine.json');
  writeFileSync(config, JSON.stringify(f.machine));

  const run = async (cursor: string | null) => {
    // Each connection observes a live resident producer, not the first child's old lease.
    f.native.reconcile({ type: 'idle' }, f.native.revision);
    await f.writer.write(f.native.snapshot());
    await f.publish();
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', 'src/cli.ts', 'control-native-stream'],
      {
        cwd: `${import.meta.dir}/..`,
        env: {
          ...process.env,
          CCMUX_CONFIG: config,
        },
        stdin: new TextEncoder().encode(JSON.stringify({ target: f.target, cursor })),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    cleanup.push(async () => {
      child.kill('SIGTERM');
      await child.exited;
    });
    return child;
  };
  const nextFrame = async (
    child: Awaited<ReturnType<typeof run>>,
    iterator: AsyncIterator<unknown>,
    label: string,
  ) => {
    const next = await iterator.next();
    if (!next.done && next.value !== undefined)
      return ControlNativeStreamFrameSchema.parse(next.value);
    child.kill('SIGTERM');
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    throw new Error(`${label} stream ended ${code}: ${error}`);
  };

  const first = await run(null);
  const firstFrames = parseNDJSON<unknown>(new Response(first.stdout), {
    maxLineBytes: 2 * 1024 * 1024,
  })[Symbol.asyncIterator]();
  const initial = await nextFrame(first, firstFrames, 'initial');
  const initialSnapshot = JSON.parse(initial.data);
  expect(initialSnapshot).toMatchObject({ target: f.target, reset: 'initial' });
  expect(readControlNativeStreamCursor(initial.cursor, f.target)).toEqual({
    generation: initialSnapshot.generation,
    sequence: initialSnapshot.sequence,
  });
  await Bun.sleep(2100);
  const heartbeat = await nextFrame(first, firstFrames, 'heartbeat');
  expect(heartbeat).toEqual(initial);
  first.kill('SIGTERM');
  expect(await first.exited).toBe(0);
  expect(await new Response(first.stderr).text()).toBe('');

  f.native.reconcile({ type: 'idle' }, f.native.revision, Date.now() - NATIVE_RUNTIME_TTL_MS - 1);
  await f.writer.write(f.native.snapshot());
  await expect(f.local.native({ target: f.target })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  const resumed = await run(initial.cursor);
  const resumedFrames = parseNDJSON<unknown>(new Response(resumed.stdout), {
    maxLineBytes: 2 * 1024 * 1024,
  })[Symbol.asyncIterator]();
  const resumedFrame = await nextFrame(resumed, resumedFrames, 'resume');
  expect(JSON.parse(resumedFrame.data)).toMatchObject({
    target: f.target,
    reset: null,
    records: [],
  });
  resumed.kill('SIGTERM');
  expect(await resumed.exited).toBe(0);

  f.native.reconcile({ type: 'idle' }, f.native.revision);
  await f.writer.write(f.native.snapshot());
  await f.publish();
  const gapCursor = encodeControlNativeStreamCursor(f.target, {
    generation: initialSnapshot.generation,
    sequence: initialSnapshot.sequence + 10_000,
  });
  const gap = await run(gapCursor);
  const gapFrames = parseNDJSON<unknown>(new Response(gap.stdout), {
    maxLineBytes: 2 * 1024 * 1024,
  })[Symbol.asyncIterator]();
  const gapFrame = await nextFrame(gap, gapFrames, 'gap');
  expect(JSON.parse(gapFrame.data).reset).toBe('gap');
  gap.kill('SIGTERM');
  expect(await gap.exited).toBe(0);

  expect(() =>
    readControlNativeStreamCursor(initial.cursor, { ...f.target, session: 'other' }),
  ).toThrow('another target');
  expect(managedPeerKey(initialSnapshot.target)).toBe(managedPeerKey(f.target));
}, 15_000);

test('a malformed request names the fields, so it cannot be read as a refusal', async () => {
  const { createCcmuxControlServiceClient } = await import('../src/control/serviceClient.ts');
  // The transport is never reached: the client refuses the shape before sending, which is the
  // point — a caller learns what is wrong with its request rather than what a server thought of it.
  const client = createCcmuxControlServiceClient(async () => new Response('{}'));
  // A truncated target and a missing permission arrive as the same word to a consumer that sees
  // only the code — one of them spent a minute looking for a grant it already had. The fields are
  // named; their values never are, because a value can carry someone's message body.
  const failure = (await client.selection
    .withOptions({ target: { machine: 'host-a', session: 'agent-a' } } as never, {})
    .catch((error: unknown) => error)) as { code?: string; message?: string };
  expect(failure.code).toBe('INVALID_INPUT');
  expect(failure.message).toContain('target.');
  expect(failure.message).not.toContain('agent-a');
});

test('a cancelled operation stops waiting for the lock instead of holding its slot', async () => {
  const { withDirectoryLock } = await import('../src/config/registryLock.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(await import('node:os').then((os) => os.tmpdir()), 'ccmux-lock-'));
  try {
    const lock = join(root, 'lock');
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withDirectoryLock(lock, async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const stop = new AbortController();
    const started = Date.now();
    // Measured on the control plane: the caller was told its request was aborted in milliseconds
    // while the work sat here for the full ten-second timeout, holding its admission slot — so the
    // next legitimate request for that session queued behind one nobody was waiting for.
    const waiter = withDirectoryLock(lock, async () => 'ran anyway', 'probe', 10_000, stop.signal);
    setTimeout(() => stop.abort(), 100);
    await expect(waiter).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    release.resolve();
    await holder;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the contract and the catalog are two indexes over one set of schemas', async () => {
  const { ccmuxControlServiceContract } = await import('../src/control/serviceClient.ts');
  const { controlServiceInputs } = await import('../src/control/serviceCatalog.ts');
  // Both exist for good reasons — the ingress dispatches by operation id, the client speaks the
  // contract — but an endpoint added to one and not the other is a wire whose two ends disagree
  // about what may be sent. Same object, not merely same shape: a copy would drift silently.
  for (const endpoint of Object.values(ccmuxControlServiceContract.endpoints)) {
    const operation = endpoint.path.slice(1) as keyof typeof controlServiceInputs;
    expect(controlServiceInputs[operation]).toBeDefined();
    if (endpoint.input !== undefined) expect(endpoint.input).toBe(controlServiceInputs[operation]);
  }
  expect(Object.keys(controlServiceInputs).length).toBe(
    Object.values(ccmuxControlServiceContract.endpoints).length,
  );
});

test('a retry is owed an answer from the receipt only once that receipt is complete', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'ccmux-create-receipt-'));
  const m = makeMachine({ stateDir });
  const { settledCreateRequest } = await import('../src/control/lifecycle.ts');
  const path = join(stateDir, 'control', 'create-requests.json');
  const id = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const row = (requestId: string, status: 'pending' | 'complete' | 'failed') => ({
    requestId,
    fingerprint: 'f'.repeat(64),
    generation: '33333333-3333-4333-8333-333333333333',
    name: 'created-a',
    workspace: '/workspace',
    flags: [],
    status,
    threadId: null,
    error: null,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  });
  const write = async (rows: unknown[]) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(rows), { mode: 0o600 });
  };

  try {
    // No store at all: nothing to answer from. This must not read as "already done".
    expect(settledCreateRequest(m, id)).toBe(false);

    // In flight. `pending` deliberately does not qualify — two runs of one create are a race, and
    // answering from an unfinished receipt would report a session that may still fail to exist.
    await write([row(id, 'pending')]);
    expect(settledCreateRequest(m, id)).toBe(false);

    // Failed is settled but has nothing to hand back: the caller's create did not happen.
    await write([row(id, 'failed')]);
    expect(settledCreateRequest(m, id)).toBe(false);

    // Complete: this is the case the whole thing exists for. A caller whose first answer was lost
    // to a transport must be able to tell "already done" from "still running", and BUSY says
    // neither.
    await write([row(id, 'complete')]);
    expect(settledCreateRequest(m, id)).toBe(true);

    // And by the id the caller retries with, not by any complete row that happens to be there.
    expect(settledCreateRequest(m, other)).toBe(false);
    await write([row(other, 'complete'), row(id, 'pending')]);
    expect(settledCreateRequest(m, id)).toBe(false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
