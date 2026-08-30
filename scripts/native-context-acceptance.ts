#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PNG } from 'pngjs';
import { loadMachineConfig } from '../src/config/machine.ts';
import { loadPendingSessions } from '../src/config/pendingSessions.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import type { ControlCreateReceipt } from '../src/control/schema.ts';
import {
  ApiError,
  CCMUX_CONTROL_SERVICE_INGRESS_PATH,
  CCMUX_CONTROL_SERVICE_PREFIX,
  CCMUX_CONTROL_SERVICE_REVISION,
  ControlServiceOperationSchema,
  createCcmuxControlServiceClient,
} from '../src/control/serviceDescriptor.ts';
import { readManagedRuntimeStatus } from '../src/runtime/status.ts';
import { killSession } from '../src/tmux/tmux.ts';
import type { ManagedPeer } from '../src/types.ts';
import { atomicWrite } from '../src/util/atomic.ts';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const report = (phase: string, evidence: unknown) =>
  console.log(JSON.stringify({ phase, evidence }));
async function until(label: string, probe: () => Promise<boolean>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    check(Date.now() < deadline, `Deadline: ${label}`);
    await Bun.sleep(200);
  }
}

const requested = process.argv[2];
if (requested === undefined) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-context-e2e-')));
  const source = loadMachineConfig();
  const {
    telegram: _telegram,
    fleet: _fleet,
    launchRecipes: _recipes,
    agentPolicies: _policies,
    ...machine
  } = source;
  check(source.codexBin && source.opencodeBin, 'Both native runtimes must be configured');
  mkdirSync(join(root, 'workspace'), { mode: 0o700 });
  check(
    Bun.spawnSync(['git', 'init', '--quiet', join(root, 'workspace')]).exitCode === 0,
    'Isolated workspace creation failed',
  );
  await atomicWrite(
    join(root, 'workspace', 'opencode.json'),
    JSON.stringify({ permission: { bash: 'allow', edit: 'deny' } }),
    0o600,
  );
  const config = join(root, 'machine.json');
  await atomicWrite(
    config,
    JSON.stringify({
      ...machine,
      rcPrefix: 'context-probe',
      stateDir: join(root, 'state'),
      tmuxSocket: `ccmux-context-${crypto.randomUUID().slice(0, 8)}`,
      fleet: {},
      agentPolicies: {},
      launchRecipes: {
        native: {
          revision: '1',
          flags: ['-a', 'never', '-s', 'workspace-write'],
          environment: [],
          capabilities: [],
        },
      },
      extraFlags: [],
      remoteControl: false,
      chatEnabled: true,
      eventsEnabled: false,
      externalInventory: false,
      ensureInterval: 3600,
      autoUpdate: false,
    }),
    0o600,
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    CCMUX_CONFIG: config,
    CCMUX_STATE_DIR: join(root, 'state'),
    CCMUX_CACHE_DIR: join(root, 'cache'),
    CCMUX_DATA_DIR: join(root, 'data'),
  };
  delete env.CCMUX_SESSION;
  delete env.CCMUX_CHAT_CREDENTIAL;
  report('isolated-fixture', { rootHash: hash(root), directoryName: basename(root) });
  const child = Bun.spawn([process.execPath, '--no-env-file', import.meta.filename, root], {
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(await child.exited);
}

const root = requested,
  m = loadMachineConfig();
check(
  basename(root).startsWith('ccmux-context-e2e-') &&
    m.stateDir === join(root, 'state') &&
    m.tmuxSocket?.startsWith('ccmux-context-') &&
    !m.telegram &&
    Object.keys(m.fleet ?? {}).length === 0,
  'Probe is not isolated',
);
const cli = join(process.cwd(), 'src/cli.ts');
const spawnDaemon = () =>
  Bun.spawn([process.execPath, '--no-env-file', cli, 'daemon'], {
    env: process.env,
    stdin: 'ignore',
    stdout: Bun.file(join(root, 'daemon.log')),
    stderr: Bun.file(join(root, 'daemon-error.log')),
  });
let daemon = spawnDaemon();
const local = createControlClient({ socket: controlSocket(m) });
const service = createCcmuxControlServiceClient(async (url, init) => {
  const route = new URL(String(url));
  const operation = ControlServiceOperationSchema.parse(
    route.pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
  );
  return fetch(`http://ccmux.local${CCMUX_CONTROL_SERVICE_INGRESS_PATH}`, {
    unix: controlSocket(m),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(init?.signal === undefined ? {} : { signal: init.signal }),
    body: JSON.stringify({
      v: 1,
      id: crypto.randomUUID(),
      caller: 'context-client',
      service: 'ccmux.control',
      revision: CCMUX_CONTROL_SERVICE_REVISION,
      operation,
      payload: typeof init?.body === 'string' ? init.body : '{}',
    }),
  });
});
const accepted: ControlCreateReceipt[] = [];
async function idle(target: ManagedPeer) {
  await until('live idle', async () => {
    try {
      const row = await service.get({ target });
      return row.availability === 'live' && row.state === 'idle';
    } catch (error) {
      if (error instanceof ApiError && ['UNAVAILABLE', 'IDENTITY_MISMATCH'].includes(error.code))
        return false;
      throw error;
    }
  });
}
async function reply(target: ManagedPeer, token: string, body: string) {
  await idle(target);
  const before = await service.native({ target });
  await service.message({ target, messageId: crypto.randomUUID(), body });
  await until('native reply', async () => {
    const result = await service.wait({ target, timeoutMs: 1_000 });
    check(result.outcome !== 'failed' && result.outcome !== 'interrupted', 'Native turn failed');
    const frame = await service.native({
      target,
      cursor: { generation: before.generation, sequence: before.sequence },
    });
    return (
      result.outcome === 'completed' &&
      [...frame.baseline, ...frame.records].some(
        (item) => item.kind === 'assistant' && item.text?.includes(token),
      )
    );
  });
}
async function image(target: ManagedPeer) {
  const png = new PNG({ width: 32, height: 32 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = 255;
    png.data[offset + 3] = 255;
  }
  const bytes = PNG.sync.write(png),
    uploadId = crypto.randomUUID();
  await service.attachmentBegin({
    target,
    uploadId,
    mediaType: 'image/png',
    totalBytes: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
  });
  await service.attachmentChunk({ target, uploadId, offset: 0, data: bytes.toString('base64') });
  return service.attachmentFinalize({ target, uploadId });
}
async function expectedRefusal(run: () => Promise<unknown>, codes: string[]) {
  try {
    await run();
  } catch (error) {
    check(
      error instanceof ApiError && codes.includes(error.code),
      `Unexpected refusal: ${error instanceof ApiError ? error.code : String(error)}`,
    );
    return;
  }
  throw new Error('Operation unexpectedly passed admission');
}
try {
  await until(
    'prepared baseline',
    async () => {
      try {
        return (await local.list()).status === 'live';
      } catch {
        return false;
      }
    },
    15_000,
  );
  check(loadSessions(m).length === 0, 'Isolated registry is not empty');
  for (const runtime of ['codex', 'opencode']) {
    if (runtime !== 'codex' && runtime !== 'opencode') throw new Error('Invalid fixture runtime');
    if (
      process.env.CCMUX_CONTEXT_RUNTIME !== undefined &&
      process.env.CCMUX_CONTEXT_RUNTIME !== runtime
    )
      continue;
    const modelSelection =
      runtime === 'codex'
        ? { provider: 'openai', model: 'gpt-5.6-luna' }
        : {
            provider: 'openrouter',
            model: process.env.CCMUX_CONTEXT_OPENCODE_MODEL ?? 'google/gemini-2.5-flash',
          };
    const create = {
      runtime,
      requestId: crypto.randomUUID(),
      name: `${runtime}-context`,
      workspace: join(root, 'workspace'),
      modelSelection,
      ...(runtime === 'codex' ? { launchRecipe: { id: 'native', revision: '1' } } : {}),
    } satisfies Parameters<typeof service.create>[0];
    const receipt = await service.create(create);
    accepted.push(receipt);
    const { target, registrationGeneration } = receipt;
    check((await service.create(create)).duplicate, 'Native create retry is not idempotent');
    await idle(target);
    await reply(
      target,
      'CONTEXT_MEMO',
      "Remember CONTEXT_MEMO as this conversation's verification word. Reply CONTEXT_MEMO only, without tools.",
    );
    const reference = await image(target);
    await service.message({
      target,
      messageId: crypto.randomUUID(),
      body: "Describe this image's dominant color and include IMAGE_SEEN. Do not use tools.",
      images: [reference],
    });
    await until('image turn', async () => {
      const waited = await service.wait({ target, timeoutMs: 1_000 });
      check(waited.outcome !== 'failed', 'Native image turn failed');
      return waited.outcome === 'completed';
    });
    const page = await service.history({ target, registrationGeneration, limit: 64 });
    check(
      page.entries.some((item) => item.images.some((ref) => ref.id === reference.id)),
      'Native image history reference is absent',
    );
    check(
      page.entries.some((item) => item.text?.includes('CONTEXT_MEMO')),
      'Native text history is absent',
    );
    const firstPage = await service.history({ target, registrationGeneration, limit: 1 });
    check(firstPage.nextCursor, 'Native history pagination has no next cursor');
    const secondPage = await service.history({
      target,
      registrationGeneration,
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    check(
      firstPage.entries[0]?.itemId !== secondPage.entries[0]?.itemId,
      'Native cursor repeated the same page',
    );
    report('history', {
      runtime,
      imageReference: true,
      text: true,
      cursor: true,
      sourceHash: hash(target.threadId),
    });

    const sourceFrame = await service.native({ target });
    const forkRequest = {
      target,
      registrationGeneration,
      generation: sourceFrame.generation,
      requestId: crypto.randomUUID(),
      name: `${runtime}-branch`,
    };
    const branch = await service.fork(forkRequest);
    accepted.push(branch);
    check(
      branch.target.threadId !== target.threadId,
      'Native fork reused the source managed identity',
    );
    check(
      (await service.fork(forkRequest)).target.threadId === branch.target.threadId,
      'Native fork retry changed identity',
    );
    await idle(branch.target);
    const branchHistory = await service.history({
      target: branch.target,
      registrationGeneration: branch.registrationGeneration,
      limit: 64,
    });
    check(
      branchHistory.entries.some((item) => item.images.some((ref) => ref.id === reference.id)),
      'Fork lost retained image reference',
    );
    await reply(
      branch.target,
      'CONTEXT_MEMO',
      'Recall the verification word we remembered earlier. Return that word only, without tools.',
    );
    const sourceAfter = await service.history({ target, registrationGeneration, limit: 64 });
    check(
      JSON.stringify(sourceAfter.entries) === JSON.stringify(page.entries),
      'Fork modified its source history',
    );
    report('fork', {
      runtime,
      distinctIdentity: true,
      duplicateRetry: true,
      inheritedContext: true,
      imageRetained: true,
      sourceUnchanged: true,
    });

    await service.message({
      target,
      messageId: crypto.randomUUID(),
      body: 'Use the shell tool to run sleep 3, then reply BUSY_CHECK_DONE. Do not change any files or contact other sessions.',
    });
    await until(
      'working native turn',
      async () => (await service.get({ target })).state === 'working',
    );
    const busy = await service.native({ target });
    await expectedRefusal(
      () =>
        service.compact({
          target,
          registrationGeneration,
          generation: busy.generation,
          operationId: crypto.randomUUID(),
        }),
      ['CONTEXT_BUSY'],
    );
    await expectedRefusal(
      () =>
        service.fork({
          target,
          registrationGeneration,
          generation: busy.generation,
          requestId: crypto.randomUUID(),
          name: `${runtime}-refused`,
        }),
      ['FORK_BUSY'],
    );
    await until(
      'busy turn completed',
      async () => (await service.wait({ target, timeoutMs: 1_000 })).outcome === 'completed',
    );
    report('busy-refusal', { runtime, compact: true, fork: true });

    const beforeCompact = await service.native({ target });
    const compact = {
      target,
      registrationGeneration,
      generation: beforeCompact.generation,
      operationId: crypto.randomUUID(),
    };
    await service.compact(compact);
    await service.compact(compact);
    await expectedRefusal(
      () =>
        service.message({
          target,
          messageId: crypto.randomUUID(),
          body: 'Do not admit while compact is unresolved.',
        }),
      ['CONTEXT_BUSY'],
    );
    await until(
      'native compaction completion',
      async () => {
        const state = await service.contextOperation({
          target,
          registrationGeneration,
          operationId: compact.operationId,
        });
        check(state.operation?.state !== 'rejected', 'Compaction was rejected');
        return state.operation?.state === 'completed';
      },
      180_000,
    );
    const reset = await service.native({
      target,
      cursor: { generation: beforeCompact.generation, sequence: beforeCompact.sequence },
    });
    check(
      reset.reset === 'context' || reset.reset === 'generation',
      'Native compact did not reset content replay',
    );
    const compacted = await service.contextOperation({
      target,
      registrationGeneration,
      operationId: compact.operationId,
    });
    check(
      compacted.operation?.revision === page.revision + 1,
      'Native compact advanced context more than once',
    );
    await expectedRefusal(
      () =>
        service.history({
          target,
          registrationGeneration,
          limit: 1,
          cursor: firstPage.nextCursor ?? undefined,
        }),
      ['HISTORY_CURSOR', 'HISTORY_UNAVAILABLE'],
    );
    await reply(
      target,
      'CONTEXT_MEMO',
      'Return our remembered verification word only. Do not use tools.',
    );
    check(
      (await service.history({ target, registrationGeneration, limit: 1 })).revision ===
        compacted.operation.revision,
      'Delayed completion reset the same native context again',
    );
    report('compact', {
      runtime,
      nativeCompleted: true,
      replayReset: reset.reset,
      staleCursorRefused: true,
      continuity: true,
      exactlyOneRevision: true,
    });

    const session = loadSessions(m).find((row) => row.uuid === target.threadId);
    check(session, 'Native source registration disappeared');
    const oldGeneration = readManagedRuntimeStatus(m, session).snapshot?.generation;
    await killSession(m, session.name);
    await service.start({ target });
    await until(
      'same identity resume',
      async () => {
        const snapshot = readManagedRuntimeStatus(m, session).snapshot;
        return (
          snapshot !== null && snapshot.generation !== oldGeneration && snapshot.state === 'idle'
        );
      },
      30_000,
    );
    check(
      (await service.fork(forkRequest)).target.threadId === branch.target.threadId,
      'Late fork retry after restart changed identity',
    );
    await reply(
      target,
      'CONTEXT_MEMO',
      'Return our remembered verification word after restart, without tools.',
    );
    check(loadPendingSessions(m).length === 0, 'Accepted native fork left a pending registration');
    report('provider-restart', {
      runtime,
      sameIdentity: true,
      continuity: true,
      lateForkRetry: true,
    });
  }
  const providers = loadSessions(m).map((session) => ({
    session,
    pid: readManagedRuntimeStatus(m, session).snapshot?.providerPid,
  }));
  check(
    providers.every((row) => row.pid !== undefined) &&
      new Set(providers.map((row) => row.pid)).size === providers.length,
    'Native writer count is not exact',
  );
  const generation = (await local.list()).generation;
  daemon.kill('SIGTERM');
  await daemon.exited;
  daemon = spawnDaemon();
  await until(
    'daemon replacement',
    async () => {
      try {
        return (await local.list()).generation !== generation;
      } catch {
        return false;
      }
    },
    15_000,
  );
  check(
    providers.every(
      (row) => readManagedRuntimeStatus(m, row.session).snapshot?.providerPid === row.pid,
    ),
    'Daemon restart replaced a native writer',
  );
  report('completed', {
    runtimes: new Set(accepted.map((row) => row.target.agent)).size,
    managedWriters: providers.length,
    daemonRestartPreservedWriters: true,
  });
} finally {
  for (const receipt of accepted) await service.archive({ target: receipt.target }).catch(() => {});
  for (const session of loadSessions(m)) await killSession(m, session.name);
  daemon.kill('SIGTERM');
  await daemon.exited;
  await local.close();
}
