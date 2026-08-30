import { afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { ownedCodexSocket } from '../src/agent/codex/ownedPaths.ts';
import type { CodexAppRpc } from '../src/agent/codex/rpc.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { createControlClient } from '../src/control/client.ts';
import { type ControlModelsConnector, readControlModels } from '../src/control/models.ts';
import { controlSocket } from '../src/control/path.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { ControlModelCatalogSchema, ControlModelsReadSchema } from '../src/control/schema.ts';
import { createControlServer } from '../src/control/server.ts';
import {
  CCMUX_CONTROL_SERVICE_INGRESS_PATH,
  CCMUX_CONTROL_SERVICE_PREFIX,
  CCMUX_CONTROL_SERVICE_REVISION,
  ControlServiceOperationSchema,
  createCcmuxControlServiceClient,
} from '../src/control/serviceDescriptor.ts';
import { UNSEEN } from '../src/events/observe.ts';
import { MonitoringPublisher } from '../src/monitoring/publish.ts';
import { makeMachine, makeSession } from './helpers.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const effort = (name: string) => ({ reasoningEffort: name, description: `${name} reasoning` });
const tier = { id: 'priority', name: 'Fast', description: '1.5x speed' };
const providerModel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  model: id,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: id.toUpperCase(),
  description: `${id} description`,
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [effort('low'), effort('medium'), effort('high')],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text', 'image'],
  supportsPersonality: false,
  additionalSpeedTiers: [],
  serviceTiers: [tier],
  defaultServiceTier: null,
  isDefault: false,
  providerInternal: 'never-forwarded',
  ...over,
});
const catalog = [
  providerModel('model-a', { isDefault: true }),
  providerModel('model-b'),
  providerModel('model-hidden', { hidden: true }),
];

type Behavior = 'ok' | 'error' | 'hang' | 'malformed' | 'oversize' | 'oversize-page';

function fakeAppServer(socket: string, providerId = 'openai', models = catalog) {
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  let client: ServerWebSocket<unknown> | null = null;
  let behavior: Behavior = 'ok';
  const requests: { method: string; params: unknown }[] = [];
  const page = (params: unknown) => {
    const includeHidden = (params as { includeHidden?: boolean })?.includeHidden === true;
    const limit =
      typeof (params as { limit?: number })?.limit === 'number'
        ? (params as { limit: number }).limit
        : catalog.length;
    const visible = models.filter((model) => includeHidden || !model.hidden);
    const raw = (params as { cursor?: string })?.cursor;
    const start = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0;
    const data = visible.slice(start, start + limit);
    return {
      data,
      nextCursor: start + data.length < visible.length ? String(start + data.length) : null,
    };
  };
  const server = Bun.serve<unknown>({
    unix: socket,
    fetch(request, target) {
      if (target.upgrade(request, { data: undefined })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        client = ws;
      },
      message(ws, raw) {
        const decoded = JSON.parse(String(raw));
        if (decoded.method === undefined) return;
        if (decoded.method === 'initialize') {
          ws.send(JSON.stringify({ id: decoded.id, result: { userAgent: 'codex/0.147.0' } }));
          return;
        }
        if (decoded.method === 'config/read') {
          ws.send(
            JSON.stringify({ id: decoded.id, result: { config: { model_provider: providerId } } }),
          );
          return;
        }
        if (decoded.method !== 'model/list') return;
        requests.push({ method: decoded.method, params: decoded.params });
        if (behavior === 'hang') return;
        if (behavior === 'error') {
          ws.send(
            JSON.stringify({ id: decoded.id, error: { code: -32000, message: 'provider failed' } }),
          );
          return;
        }
        if (behavior === 'malformed') {
          ws.send(
            JSON.stringify({ id: decoded.id, result: { data: [{ id: 42 }], nextCursor: null } }),
          );
          return;
        }
        if (behavior === 'oversize') {
          ws.send(
            JSON.stringify({
              id: decoded.id,
              result: {
                data: [providerModel('model-a', { description: 'x'.repeat(2_049) })],
                nextCursor: null,
              },
            }),
          );
          return;
        }
        if (behavior === 'oversize-page') {
          const heavy = providerModel('model-heavy', {
            description: 'x'.repeat(2_048),
            supportedReasoningEfforts: Array.from({ length: 32 }, (_, index) => ({
              reasoningEffort: `e${index}`,
              description: 'r'.repeat(1_024),
            })),
          });
          const light = providerModel('model-light', { description: 'y'.repeat(64) });
          ws.send(
            JSON.stringify({
              id: decoded.id,
              result: {
                data: [
                  ...Array.from({ length: 10 }, () => heavy),
                  ...Array.from({ length: 54 }, () => light),
                ],
                nextCursor: null,
              },
            }),
          );
          return;
        }
        ws.send(JSON.stringify({ id: decoded.id, result: page(decoded.params) }));
      },
    },
  });
  return {
    requests,
    set(value: Behavior) {
      behavior = value;
    },
    close: () => server.stop(true),
    disconnect: () => client?.close(),
  };
}

async function fixture(options: { extraClaudeSession?: boolean } = {}) {
  const root = mkdtempSync('/tmp/ccmux-models-test-');
  const codexHome = join(root, 'codex');
  const m = makeMachine({
    stateDir: root,
    rcPrefix: 'host-a',
    projectsDir: join(root, 'history'),
    chatEnabled: true,
    codexHome,
  });
  const s = makeSession({
    name: 'agent-a',
    dir: root,
    agent: 'codex',
    runtime: 'app-server',
    chat: true,
  });
  const sessions = [s];
  if (options.extraClaudeSession)
    sessions.push(
      makeSession({ name: 'agent-b', dir: root, agent: 'claude', runtime: 'tui', chat: true }),
    );
  await writeSessionsUnlocked(m, sessions);
  const p = new ControlPublisher(m);
  const monitoring = new MonitoringPublisher();
  const publish = async () => {
    monitoring.begin(m);
    monitoring.sample(m, s, 1, '❯\n? for shortcuts', UNSEEN);
    p.publish(m, await monitoring.publish(m));
  };
  await publish();
  const provider = fakeAppServer(ownedCodexSocket(m, s.name));
  const owned = createControlServer(m, p);
  const socket = controlSocket(m);
  const client = createControlClient({ socket });
  cleanup.push(async () => {
    await client.close();
    p.close();
    provider.close();
    await owned.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await owned.observability.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    m,
    s,
    p,
    publish,
    owned,
    client,
    socket,
    root,
    codexHome,
    provider,
    target: managedPeer(m.rcPrefix, s),
    claudeTarget: sessions[1] ? managedPeer(m.rcPrefix, sessions[1]) : null,
    remote: createCcmuxControlServiceClient(async (url, init) => {
      const route = new URL(String(url));
      const operation = ControlServiceOperationSchema.parse(
        route.pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
      );
      const payload = typeof init?.body === 'string' ? init.body : '{}';
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
    }),
  };
}

const invoke = (f: Awaited<ReturnType<typeof fixture>>, body: unknown) =>
  fetch(`http://ccmux.local${CCMUX_CONTROL_SERVICE_INGRESS_PATH}`, {
    unix: f.socket,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('model catalog is a bounded provider-owned read that forwards only safe metadata', async () => {
  const f = await fixture();
  const read = await f.client.models({ target: f.target, runtime: 'codex' });
  expect(read.source.runtime).toBe('codex');
  expect(read.target).toEqual(f.target);
  expect(read.data.map((model) => model.id)).toEqual(['model-a', 'model-b']);
  expect(read.data[0]).toMatchObject({
    displayName: 'MODEL-A',
    isDefault: true,
    hidden: false,
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
  });
  assert(read.data[0]);
  expect(Object.keys(read.data[0]).sort()).toEqual(
    [
      'defaultReasoningEffort',
      'description',
      'displayName',
      'hidden',
      'id',
      'model',
      'inputModalities',
      'isDefault',
      'serviceTiers',
      'supportedReasoningEfforts',
    ].sort(),
  );
  expect(JSON.stringify(read)).not.toContain('never-forwarded');
  expect(JSON.stringify(read)).not.toContain(f.codexHome);
  expect(ControlModelCatalogSchema.parse(read)).toEqual(read);
  expect(f.provider.requests).toEqual([{ method: 'model/list', params: { limit: 64 } }]);
});

test('pagination is deterministic, provider-cursored and bounded by the strict input schema', async () => {
  const f = await fixture();
  const first = await f.remote.models({ target: f.target, runtime: 'codex', limit: 1 });
  expect(first.data.map((model) => model.id)).toEqual(['model-a']);
  expect(first.nextCursor).toBe('1');
  const second = await f.remote.models({
    target: f.target,
    runtime: 'codex',
    cursor: first.nextCursor,
    limit: 1,
  });
  expect(first.source).toEqual({
    kind: 'session',
    runtime: 'codex',
    machine: f.m.rcPrefix,
    provider: 'openai',
  });
  expect(second.source).toEqual(first.source);
  expect(second.data.map((model) => model.id)).toEqual(['model-b']);
  expect(second.nextCursor).toBeNull();
  expect(f.provider.requests[1]).toEqual({
    method: 'model/list',
    params: { limit: 1, cursor: '1' },
  });
  expect(ControlModelsReadSchema.safeParse({ target: f.target, limit: 0 }).success).toBe(false);
  expect(ControlModelsReadSchema.safeParse({ target: f.target, limit: 65 }).success).toBe(false);
  expect(
    ControlModelsReadSchema.safeParse({ target: f.target, cursor: 'x'.repeat(4_097) }).success,
  ).toBe(false);
  expect(ControlModelsReadSchema.safeParse({ target: f.target, extra: 1 }).success).toBe(false);
});

test('includeHidden is forwarded and hidden models stay marked', async () => {
  const f = await fixture();
  const read = await f.client.models({ target: f.target, includeHidden: true });
  expect(read.data.map((model) => [model.id, model.hidden])).toEqual([
    ['model-a', false],
    ['model-b', false],
    ['model-hidden', true],
  ]);
  expect(f.provider.requests[0]?.params).toEqual({ limit: 64, includeHidden: true });
});

test('exact session runtime cannot borrow another socket or relabel a custom provider catalog', async () => {
  const f = await fixture();
  const other = makeSession({
    name: 'agent-other',
    dir: f.root,
    agent: 'codex',
    runtime: 'app-server',
  });
  const custom = makeSession({
    name: 'agent-custom',
    dir: f.root,
    agent: 'codex',
    runtime: 'app-server',
  });
  await writeSessionsUnlocked(f.m, [f.s, other, custom]);
  const otherProvider = fakeAppServer(ownedCodexSocket(f.m, other.name), 'openai', [
    providerModel('unique-model'),
  ]);
  const customProvider = fakeAppServer(ownedCodexSocket(f.m, custom.name), 'custom');
  try {
    const page = await f.remote.models({ target: managedPeer(f.m.rcPrefix, other) });
    expect(page.data.map((row) => row.id)).toEqual(['unique-model']);
    expect(f.provider.requests).toEqual([]);
    expect(page.source.kind).toBe('session');
    await expect(
      f.remote.models({ target: managedPeer(f.m.rcPrefix, custom) }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(customProvider.requests).toEqual([]);
    otherProvider.close();
    await expect(
      f.remote.models({ target: managedPeer(f.m.rcPrefix, other) }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.provider.requests).toEqual([]);
  } finally {
    otherProvider.close();
    customProvider.close();
  }
});

test('unknown identities fail closed before any provider contact', async () => {
  const f = await fixture();
  for (const target of [
    { ...f.target, threadId: crypto.randomUUID() },
    { ...f.target, machine: 'host-b' },
    { ...f.target, agent: 'claude' as const },
  ]) {
    await expect(f.client.models({ target })).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
      status: 409,
    });
    await expect(f.remote.models({ target })).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
      status: 409,
    });
  }
  expect(f.provider.requests).toEqual([]);
});

test('explicit runtime mismatch refuses before dispatch even with a valid target', async () => {
  const f = await fixture();
  for (const runtime of ['opencode', 'custom', 'claude'] satisfies Array<
    'opencode' | 'custom' | 'claude'
  >) {
    await expect(f.remote.models({ target: f.target, runtime })).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
    });
    await expect(f.client.models({ target: f.target, runtime })).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
    });
  }
  expect(f.provider.requests).toEqual([]);
});

test('non-owned runtimes have no model catalog', async () => {
  const f = await fixture({ extraClaudeSession: true });
  assert(f.claudeTarget);
  await expect(f.client.models({ target: f.claudeTarget })).rejects.toMatchObject({
    code: 'UNSUPPORTED',
    status: 409,
  });
  expect(f.provider.requests).toEqual([]);
});

test('malformed and oversized provider payloads fail closed without partial catalogs', async () => {
  const f = await fixture();
  f.provider.set('malformed');
  await expect(f.client.models({ target: f.target })).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    status: 503,
  });
  f.provider.set('oversize');
  await expect(f.client.models({ target: f.target })).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    status: 503,
  });
  f.provider.set('ok');
  expect((await f.client.models({ target: f.target })).data).toHaveLength(2);
});

test('provider failures fail closed instead of substituting a local catalog', async () => {
  const f = await fixture();
  f.provider.set('error');
  await expect(f.client.models({ target: f.target })).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    status: 503,
  });
  await expect(f.remote.models({ target: f.target })).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    status: 503,
  });
  f.provider.disconnect();
  await expect(f.client.models({ target: f.target })).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    status: 503,
  });
});

test('catalog failure retains the exact cause only in private owner diagnostics', async () => {
  const f = await fixture();
  const marker = 'fixture-private-catalog-cause';
  const connect: ControlModelsConnector = async () => {
    throw new Error(marker);
  };
  const error = await readControlModels(
    f.m,
    { target: f.target, cursor: null, limit: 64, includeHidden: false },
    new AbortController().signal,
    connect,
  ).catch((cause: unknown) => cause);
  expect(error).toMatchObject({
    code: 'UNAVAILABLE',
    status: 503,
    message: 'Model catalog is unavailable',
  });
  expect(String(error)).not.toContain(marker);
  expect(JSON.stringify(error)).not.toContain(marker);
  const root = join(f.m.stateDir, 'native-diagnostics');
  const files = readdirSync(root);
  expect(files).toHaveLength(1);
  assert(files[0]);
  const path = join(root, files[0]);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ stage: 'model-catalog' });
  expect(readFileSync(path, 'utf8')).toContain(marker);
  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('unconfigured provider homes fail closed', async () => {
  const root = mkdtempSync('/tmp/ccmux-models-unit-');
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const m = makeMachine({ stateDir: root, rcPrefix: 'host-a', projectsDir: join(root, 'history') });
  const s = makeSession({ name: 'agent-a', dir: root, agent: 'codex', runtime: 'app-server' });
  await writeSessionsUnlocked(m, [s]);
  await expect(
    readControlModels(
      m,
      { target: managedPeer(m.rcPrefix, s), cursor: null, limit: 64, includeHidden: false },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
});

test('handler bounds drop provider extras, honor optional efforts and reject oversized pages', async () => {
  const root = mkdtempSync('/tmp/ccmux-models-unit-');
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const m = makeMachine({
    stateDir: root,
    rcPrefix: 'host-a',
    projectsDir: join(root, 'history'),
    codexHome: join(root, 'codex'),
  });
  const s = makeSession({ name: 'agent-a', dir: root, agent: 'codex', runtime: 'app-server' });
  await writeSessionsUnlocked(m, [s]);
  const target = managedPeer(m.rcPrefix, s);
  const connect =
    (respond: () => unknown): ControlModelsConnector =>
    async () => ({
      request: (method) =>
        Promise.resolve(
          method === 'config/read' ? { config: { model_provider: 'openai' } } : respond(),
        ),
      close: () => undefined,
    });
  const minimal = await readControlModels(
    m,
    { target, cursor: null, limit: 64, includeHidden: true },
    new AbortController().signal,
    connect(() => ({
      data: [
        providerModel('model-a', {
          supportedReasoningEfforts: undefined,
          defaultReasoningEffort: undefined,
        }),
      ],
      nextCursor: null,
    })),
  );
  assert(minimal.data[0]);
  expect(Object.keys(minimal.data[0])).not.toContain('supportedReasoningEfforts');
  expect(Object.keys(minimal.data[0])).not.toContain('defaultReasoningEffort');
  const connectThrowing: ControlModelsConnector = async () => {
    throw new Error('connect failed');
  };
  await expect(
    readControlModels(
      m,
      { target, cursor: null, limit: 64, includeHidden: false },
      new AbortController().signal,
      connectThrowing,
    ),
  ).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
  await expect(
    readControlModels(
      m,
      { target, cursor: null, limit: 64, includeHidden: false },
      new AbortController().signal,
      connect(() => ({
        data: Array.from({ length: 65 }, () => providerModel('model-a')),
        nextCursor: null,
      })),
    ),
  ).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
  const cancel = new AbortController();
  cancel.abort();
  const connectHanging: ControlModelsConnector = (_machine, options) =>
    new Promise<CodexAppRpc>((_resolve, reject) => {
      options.signal?.throwIfAborted();
      options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
        once: true,
      });
    });
  await expect(
    readControlModels(
      m,
      { target, cursor: null, limit: 64, includeHidden: false },
      cancel.signal,
      connectHanging,
    ),
  ).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
});

test('declared service dispatch keeps the envelope, effect metadata and response budget for model.list', async () => {
  const f = await fixture();
  const envelope = {
    v: 1,
    id: crypto.randomUUID(),
    caller: 'host-b',
    service: 'ccmux.control',
    revision: CCMUX_CONTROL_SERVICE_REVISION,
    operation: 'model.list',
    payload: JSON.stringify({ target: f.target }),
  };
  const reply = await (await invoke(f, envelope)).json();
  const local = await f.client.models({ target: f.target });
  expect(reply).toEqual({ v: 1, revision: CCMUX_CONTROL_SERVICE_REVISION, result: local });
  expect((await invoke(f, { ...envelope, operation: 'unknown.op' })).status).toBe(400);
  expect(
    (await invoke(f, { ...envelope, payload: JSON.stringify({ target: f.target, limit: 65 }) }))
      .status,
  ).toBe(400);
  expect((await invoke(f, { ...envelope, revision: 'obsolete' })).status).toBe(400);

  f.provider.set('oversize-page');
  expect(JSON.stringify(await f.client.models({ target: f.target })).length).toBeGreaterThan(
    256 * 1024,
  );
  await expect(f.remote.models({ target: f.target })).rejects.toMatchObject({
    code: 'RESPONSE_TOO_LARGE',
    status: 500,
  });
});

test('reads admission bounds provider connections; cancellation and deadline release the caller', async () => {
  const f = await fixture();
  f.provider.set('hang');
  const stop = new AbortController();
  const cancelled = f.client.models
    .withOptions({ target: f.target }, { signal: stop.signal })
    .catch((error: unknown) => error);
  await Bun.sleep(50);
  stop.abort();
  expect(await cancelled).toMatchObject({ code: 'REQUEST_ABORTED' });
  for (let i = 0; i < 100 && f.owned.controls.reads.getSnapshot().active; i++) await Bun.sleep(20);
  expect(f.owned.controls.reads.getSnapshot().active).toBe(0);
  const leases = Array.from({ length: 4 }, () => f.owned.controls.reads.acquire());
  expect(leases.every((lease) => lease.outcome === 'leased')).toBe(true);
  const rejected = f.client.models({ target: f.target }).catch((error: unknown) => error);
  await Bun.sleep(50);
  expect(await rejected).toMatchObject({ code: 'BUSY', status: 429 });
  for (const lease of leases) if (lease.outcome === 'leased') lease.lease.release();
  await expect(f.client.models({ target: f.target })).rejects.toMatchObject({
    code: 'TIMEOUT',
    status: 504,
  });
  for (let i = 0; i < 100 && f.owned.controls.reads.getSnapshot().active; i++) await Bun.sleep(20);
  expect(f.owned.controls.reads.getSnapshot().active).toBe(0);
  f.provider.set('ok');
  expect((await f.client.models({ target: f.target })).data).toHaveLength(2);
}, 20_000);

test('zod model schemas accept canonical safe shapes only', () => {
  const peer = {
    kind: 'managed' as const,
    source: 'ccmux' as const,
    machine: 'host-a',
    agent: 'codex' as const,
    session: 'agent-a',
    threadId: '11111111-1111-4111-8111-111111111111',
  };
  const source = { kind: 'session', runtime: 'codex', machine: 'host-a', provider: 'openai' };
  expect(
    ControlModelCatalogSchema.safeParse({
      source: { kind: 'host', machine: 'host-a', provider: 'openai' },
      data: [],
      nextCursor: null,
    }).success,
  ).toBe(false);
  expect(
    ControlModelCatalogSchema.safeParse({ target: peer, source, data: [], nextCursor: null })
      .success,
  ).toBe(true);
  expect(
    ControlModelCatalogSchema.safeParse({
      target: peer,
      source,
      data: [
        {
          id: 'model-a',
          displayName: 'A',
          description: '',
          hidden: false,
          isDefault: true,
          inputModalities: ['text'],
          serviceTiers: [{ id: 't', name: 'T', description: '' }],
          supportedReasoningEfforts: [effort('low')],
          defaultReasoningEffort: 'low',
        },
      ],
      nextCursor: 'cursor',
    }).success,
  ).toBe(true);
  expect(
    ControlModelCatalogSchema.safeParse({
      target: peer,
      source,
      data: [
        {
          id: 'model-a',
          displayName: 'A',
          description: '',
          hidden: false,
          isDefault: true,
          inputModalities: ['text'],
          serviceTiers: [],
          extra: 1,
        },
      ],
      nextCursor: null,
    }).success,
  ).toBe(false);
});
