#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadMachineConfig } from '../src/config/machine.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import type {
  ControlCreate,
  ControlCreateReceipt,
  ControlModel,
  ControlNativeSnapshot,
} from '../src/control/schema.ts';
import { ApiError } from '../src/control/serviceDescriptor.ts';
import { type NativeTurnOptions, NativeTurnOptionsSchema } from '../src/runtime/selectionSchema.ts';
import { readManagedRuntimeStatus } from '../src/runtime/status.ts';
import { killSession, listSessionNames } from '../src/tmux/tmux.ts';
import type { ManagedPeer } from '../src/types.ts';
import { atomicWrite } from '../src/util/atomic.ts';
import {
  check,
  hash,
  policyService as nativeService,
  report,
  retainReports,
  until,
} from './native-policy-fixture.ts';

const requestedRoot = process.argv[2];
if (requestedRoot === undefined) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-selection-e2e-')));
  chmodSync(root, 0o700);
  const {
    telegram: _telegram,
    fleet: _fleet,
    launchRecipes: _recipes,
    agentPolicies: _policies,
    ...machine
  } = loadMachineConfig();
  check(machine.codexBin && machine.opencodeBin, 'Both existing native runtimes are required');
  for (const runtime of ['codex', 'opencode']) mkdirSync(join(root, runtime), { mode: 0o700 });
  await atomicWrite(
    join(root, 'opencode', 'opencode.json'),
    JSON.stringify({ permission: { bash: 'ask' } }),
    0o600,
  );
  const config = join(root, 'machine.json');
  await atomicWrite(
    config,
    JSON.stringify({
      ...machine,
      rcPrefix: 'selection-probe',
      stateDir: join(root, 'state'),
      tmuxSocket: `ccmux-selection-${crypto.randomUUID().slice(0, 8)}`,
      fleet: {},
      launchRecipes: {},
      agentPolicies: {},
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
  report('isolated-probe', { directoryHash: hash(root), retainedDirectoryName: basename(root) });
  const child = Bun.spawn([process.execPath, '--no-env-file', import.meta.filename, root], {
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(await child.exited);
}
const root = requestedRoot;
check(basename(root).startsWith('ccmux-selection-e2e-'), 'Not an isolated selection probe');
retainReports(root);
const m = loadMachineConfig();
check(
  m.stateDir === join(root, 'state') &&
    m.tmuxSocket?.startsWith('ccmux-selection-') &&
    !m.telegram &&
    Object.keys(m.fleet ?? {}).length === 0,
  'Isolation guard failed',
);
const service = nativeService(m, () => {});
let local = createControlClient({ socket: controlSocket(m) });
const cli = join(process.cwd(), 'src/cli.ts');
const spawnDaemon = () =>
  Bun.spawn([process.execPath, '--no-env-file', cli, 'daemon'], {
    env: process.env,
    stdin: 'ignore',
    stdout: Bun.file(join(root, 'daemon.log')),
    stderr: Bun.file(join(root, 'daemon-error.log')),
  });
let daemon = spawnDaemon();
const accepted: Array<{
  request: ControlCreate;
  receipt: ControlCreateReceipt;
  latest: NativeTurnOptions;
}> = [];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function selectionTarget(receipt: ControlCreateReceipt) {
  return { target: receipt.target, registrationGeneration: receipt.registrationGeneration };
}
async function refused(code: string, operation: () => Promise<unknown>) {
  try {
    await operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    check(
      error instanceof ApiError && error.code === code,
      `Expected ${code}, got ${error instanceof ApiError ? error.code : String(error)}`,
    );
  }
}
async function ready(target: ManagedPeer) {
  await until('native ready', async () => {
    try {
      const row = await service.get({ target });
      return row.availability === 'live' && row.state === 'idle';
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAVAILABLE') return false;
      throw error;
    }
  });
}
async function catalog(runtime: 'codex' | 'opencode') {
  const rows: ControlModel[] = [];
  let cursor: string | null = null;
  do {
    const page = await service.models({ runtime, cursor });
    rows.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return rows;
}
function choose(rows: ControlModel[], names: string[]) {
  const row = names
    .map((name) => rows.find((item) => (item.model ?? item.id) === name))
    .find((item) => item !== undefined);
  check(row, 'Required native acceptance model is absent from catalog');
  return row;
}
function options(
  runtime: 'codex' | 'opencode',
  row: ControlModel,
  plan = false,
): NativeTurnOptions {
  const model = { provider: row.provider ?? 'openai', model: row.model ?? row.id };
  return NativeTurnOptionsSchema.parse(
    runtime === 'codex'
      ? {
          runtime,
          model,
          mode: plan ? 'plan' : 'default',
          ...(row.supportedReasoningEfforts?.some((item) => item.reasoningEffort === 'low')
            ? { effort: 'low' }
            : {}),
        }
      : { runtime, model },
  );
}
async function change(receipt: ControlCreateReceipt, next: NativeTurnOptions) {
  await ready(receipt.target);
  const current = (await service.selection(selectionTarget(receipt))).current;
  const input = {
    ...selectionTarget(receipt),
    operationId: crypto.randomUUID(),
    expectedRevision: current.revision,
    options: next,
  };
  const result = await service.select(input);
  check(
    result.current.revision === current.revision + 1 && same(result.current.options, next),
    'Default selection was not accepted exactly',
  );
  check(same(await service.select(input), result), 'Selection retry changed its result');
  await refused('REVISION_CONFLICT', () =>
    service.select({ ...input, operationId: crypto.randomUUID() }),
  );
  await refused('IDEMPOTENCY_CONFLICT', () =>
    service.select({ ...input, expectedRevision: result.current.revision }),
  );
  return result.current;
}
async function expectEvidence(
  receipt: ControlCreateReceipt,
  expected: NativeTurnOptions,
  before: ControlNativeSnapshot,
  marker: string,
) {
  let proof: ControlNativeSnapshot | undefined;
  await until('native terminal selection evidence', async () => {
    const frame = await service.native({
      target: receipt.target,
      cursor: { generation: before.generation, sequence: before.sequence },
    });
    const row = await service.get({ target: receipt.target });
    check(
      row.turn?.status !== 'failed' && row.turn?.status !== 'interrupted',
      'Native selection turn failed',
    );
    const fresh = row.turn !== null && row.turn?.id !== beforeTurn(before);
    const content = [...frame.baseline, ...frame.records]
      .filter((item) => item.kind === 'assistant')
      .map((item) => item.text ?? '')
      .join('');
    if (!fresh || row.turn?.status !== 'completed' || !content.includes(marker)) return false;
    const native = frame.nativeSelection;
    check(
      native && same(native.model, expected.model),
      'Native effective model differs from accepted turn options',
    );
    if (expected.runtime === 'codex') {
      check(
        native.source === 'settings' &&
          native.options?.runtime === 'codex' &&
          native.options.mode === expected.mode,
        'Codex native settings did not prove effective mode',
      );
      if (expected.effort !== undefined)
        check(
          native.options.effort === expected.effort,
          'Codex native settings lost selected effort',
        );
    } else
      check(
        native.source === 'assistant' && native.turnId === row.turn.id,
        'OpenCode model evidence is not current-turn native assistant metadata',
      );
    proof = frame;
    return true;
  });
  check(proof, 'No native selection proof');
  await until('completed native turn settles after delivery receipt', async () => {
    const settled = await service.wait({ target: receipt.target, timeoutMs: 1000 });
    check(
      settled.outcome !== 'failed' && settled.outcome !== 'interrupted',
      'Completed native turn failed while settling',
    );
    return settled.outcome === 'completed';
  });
  report('native-selection', {
    runtime: receipt.target.agent,
    targetHash: hash(receipt.target.threadId),
    nativeSelection: proof.nativeSelection,
  });
}
function beforeTurn(frame: ControlNativeSnapshot) {
  return (
    [...frame.baseline, ...frame.records].findLast((item) => item.kind === 'terminal')?.turnId ??
    null
  );
}
async function turn(
  receipt: ControlCreateReceipt,
  expected: NativeTurnOptions,
  override?: NativeTurnOptions,
  busy = false,
) {
  await ready(receipt.target);
  const before = await service.native({ target: receipt.target });
  const marker = `SELECTION_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const defaults = (await service.selection(selectionTarget(receipt))).current;
  const message = {
    target: receipt.target,
    messageId: crypto.randomUUID(),
    body: `Reply exactly ${marker}. Do not use tools or edit files.`,
    ...(override === undefined ? {} : { options: override }),
  };
  const sent = await service.message(message);
  check(
    same(sent.turnOptions, { revision: defaults.revision, options: expected }),
    'Message did not pin accepted options',
  );
  check((await service.message(message)).duplicate, 'Message retry was not idempotent');
  if (busy) {
    await until(
      'positive native busy turn',
      async () => (await service.get({ target: receipt.target })).state === 'working',
    );
    await refused('BUSY', () =>
      service.select({
        ...selectionTarget(receipt),
        operationId: crypto.randomUUID(),
        expectedRevision: defaults.revision,
        options: expected,
      }),
    );
  }
  await expectEvidence(receipt, expected, before, marker);
  check(
    same((await service.selection(selectionTarget(receipt))).current, defaults),
    'Per-turn dispatch changed session defaults',
  );
}
async function pending(
  receipt: ControlCreateReceipt,
  selected: NativeTurnOptions,
  kind: 'input' | 'approval',
) {
  await ready(receipt.target);
  const before = await service.native({ target: receipt.target });
  const marker = `RESPONSE_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const body =
    kind === 'approval'
      ? `Use the bash tool exactly once to execute sleep 5; printf selection-probe. Wait for permission. Then reply exactly ${marker}.`
      : `Use the native ${receipt.target.agent === 'codex' ? 'request_user_input' : 'question'} tool exactly once to ask me to choose Red or Blue. Wait for my answer, then reply exactly ${marker}. Do not use any other tools or edit files.`;
  await service.message({ target: receipt.target, messageId: crypto.randomUUID(), body });
  let frame: ControlNativeSnapshot | undefined;
  await until(`native ${kind} pending`, async () => {
    const read = await service.native({ target: receipt.target });
    if (read.pending.some((item) => item.kind === kind)) {
      frame = read;
      return true;
    }
    check(
      (await service.get({ target: receipt.target })).turn?.status !== 'failed',
      'Pending probe turn failed',
    );
    return false;
  });
  check(frame, 'Pending frame is absent');
  const request = frame.pending.find((item) => item.kind === kind);
  check(request, 'Exact pending request is absent');
  const current = (await service.selection(selectionTarget(receipt))).current;
  await refused('BUSY', () =>
    service.select({
      ...selectionTarget(receipt),
      operationId: crypto.randomUUID(),
      expectedRevision: current.revision,
      options: selected,
    }),
  );
  await service.respond({
    target: receipt.target,
    operationId: crypto.randomUUID(),
    generation: frame.generation,
    requestId: request.requestId,
    kind,
    decision: kind === 'approval' ? 'accept' : null,
    answers:
      kind === 'approval'
        ? null
        : Object.fromEntries(
            request.questions.map((question) => [
              question.id,
              [question.options?.[0]?.label ?? 'Red'],
            ]),
          ),
  });
  if (kind === 'approval') {
    await until(
      'positive native approved tool busy turn',
      async () => (await service.get({ target: receipt.target })).state === 'working',
    );
    await refused('BUSY', () =>
      service.select({
        ...selectionTarget(receipt),
        operationId: crypto.randomUUID(),
        expectedRevision: current.revision,
        options: selected,
      }),
    );
  }
  await expectEvidence(receipt, selected, before, marker);
  report('pending-refusal', {
    runtime: receipt.target.agent,
    kind,
    exactRequestAnswered: true,
    selectionRefused: true,
  });
}
try {
  await until(
    'empty source service baseline',
    async () => {
      try {
        return (await local['session.list']()).status === 'live';
      } catch {
        return false;
      }
    },
    20_000,
  );
  check(
    loadSessions(m).length === 0 && (await listSessionNames(m)).size === 0,
    'Selection baseline is not empty',
  );
  for (const runtime of ['codex', 'opencode']) {
    check(runtime === 'codex' || runtime === 'opencode', 'Unexpected runtime');
    const rows = await catalog(runtime);
    const a = options(
      runtime,
      choose(rows, runtime === 'codex' ? ['gpt-5.6-luna'] : ['z-ai/glm-5.3-flash']),
    );
    const b = options(
      runtime,
      choose(
        rows,
        runtime === 'codex'
          ? ['gpt-5.4-mini', 'gpt-5.6-terra']
          : ['google/gemini-2.5-flash', 'openai/gpt-4.1-mini', 'qwen/qwen3-coder-flash'],
      ),
    );
    check(
      !same(a.model, b.model) && a.model.provider === b.model.provider,
      'Two distinct same-provider native models are required',
    );
    report('native-catalog', { runtime, a, b });
    const request: ControlCreate = {
      runtime,
      requestId: crypto.randomUUID(),
      name: `${runtime}-selection`,
      workspace: join(root, runtime),
      modelSelection: a.model,
    };
    const receipt = await service.create(request);
    accepted.push({ request, receipt, latest: b });
    check((await service.create(request)).duplicate, 'Create retry did not reuse managed identity');
    await turn(receipt, (await service.selection(selectionTarget(receipt))).current.options);
    await change(receipt, b);
    await turn(receipt, b, undefined, runtime === 'codex');
    await turn(receipt, a, a);
    await turn(receipt, b);
    const delayedBefore = await service.native({ target: receipt.target });
    const delayedMarker = `DELAYED_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const delayed = {
      target: receipt.target,
      messageId: crypto.randomUUID(),
      notBefore: new Date(Date.now() + 8_000).toISOString(),
      body: `Reply exactly ${delayedMarker}. Do not use tools or edit files.`,
    };
    const pinned = await service.message(delayed);
    check(
      same(pinned.turnOptions?.options, b),
      'Delayed message was not pinned to current defaults',
    );
    await change(receipt, a);
    check(
      same((await service.message(delayed)).turnOptions, pinned.turnOptions),
      'Delayed retry changed pinned options',
    );
    await expectEvidence(receipt, b, delayedBefore, delayedMarker);
    check(
      same((await service.selection(selectionTarget(receipt))).current.options, a),
      'Delayed dispatch rolled back current defaults',
    );
    report('delayed-options', {
      runtime,
      pinnedRevision: pinned.turnOptions?.revision,
      modelPinned: true,
      laterDefaultPreserved: true,
    });
    if (a.runtime === 'codex') {
      const plan = NativeTurnOptionsSchema.parse({ ...a, mode: 'plan' });
      await change(receipt, plan);
      await pending(receipt, plan, 'input');
      await change(receipt, a);
      await turn(receipt, a);
      report('mode-switch', { runtime, preservedModelAndEffort: true, planToDefault: true });
    } else {
      await pending(receipt, a, 'input');
      await pending(receipt, a, 'approval');
    }
    const current = (await service.selection(selectionTarget(receipt))).current;
    await refused('UNSUPPORTED', () =>
      service.select({
        ...selectionTarget(receipt),
        operationId: crypto.randomUUID(),
        expectedRevision: current.revision,
        options: { ...a, model: { ...a.model, model: 'missing-model-selection-fixture' } },
      }),
    );
    await refused('UNSUPPORTED', () =>
      service.select({
        ...selectionTarget(receipt),
        operationId: crypto.randomUUID(),
        expectedRevision: current.revision,
        options: { ...a, model: { provider: 'not-configured', model: a.model.model } },
      }),
    );
    await change(receipt, b);
  }
  const oldGeneration = (await local['session.list']()).generation;
  const providers = accepted.map(({ receipt }) => {
    const session = loadSessions(m).find((row) => row.uuid === receipt.target.threadId);
    check(session, 'Missing restart registration');
    const snapshot = readManagedRuntimeStatus(m, session).snapshot;
    check(snapshot?.providerPid, 'No positive native PID baseline');
    return { session, snapshot };
  });
  daemon.kill('SIGTERM');
  await daemon.exited;
  await local.close();
  local = createControlClient({ socket: controlSocket(m) });
  daemon = spawnDaemon();
  await until(
    'new daemon generation',
    async () => {
      try {
        const now = await local['session.list']();
        return now.status === 'live' && now.generation !== oldGeneration;
      } catch {
        return false;
      }
    },
    20_000,
  );
  for (const [index, entry] of accepted.entries()) {
    const prior = providers[index];
    check(prior, 'Restart baseline missing');
    await ready(entry.receipt.target);
    check(
      readManagedRuntimeStatus(m, prior.session).snapshot?.providerPid ===
        prior.snapshot.providerPid,
      'Daemon restart replaced a provider writer',
    );
    const defaults = (await service.selection(selectionTarget(entry.receipt))).current;
    check(same(defaults.options, entry.latest), 'Daemon restart lost latest defaults');
    await killSession(m, prior.session.name);
    await service.start({ target: entry.receipt.target });
    await until(
      'provider epoch replacement',
      async () => {
        try {
          return (
            (await service.native({ target: entry.receipt.target })).generation !==
            prior.snapshot.generation
          );
        } catch {
          return false;
        }
      },
      30_000,
    );
    await ready(entry.receipt.target);
    const resumed = loadSessions(m).find((row) => row.uuid === prior.session.uuid);
    check(
      resumed?.registrationGeneration === prior.session.registrationGeneration &&
        resumed?.nativeSession?.id === prior.session.nativeSession?.id,
      'Provider restart changed managed/native identity',
    );
    const retry = await service.create(entry.request);
    check(
      retry.duplicate &&
        same(retry.modelSelection, entry.request.modelSelection) &&
        same(retry.target, entry.receipt.target),
      'Late create receipt lost immutable selection',
    );
    check(
      same((await service.selection(selectionTarget(entry.receipt))).current, defaults),
      'Late create retry rolled back latest defaults',
    );
    await turn(entry.receipt, entry.latest);
    await service.archive({ target: entry.receipt.target });
    report('restart', {
      runtime: entry.receipt.target.agent,
      targetHash: hash(prior.session.uuid),
      daemonWriterPreserved: true,
      providerResumedSameIdentity: true,
      latestDefaultsPreserved: true,
      lateCreateImmutable: true,
      archived: true,
    });
  }
  report('completed', {
    realNativeRuntimes: 2,
    modelsPerRuntime: 2,
    serviceRevision: '2',
    allChecksPassed: true,
  });
} catch (error) {
  await atomicWrite(
    join(root, 'failure.txt'),
    error instanceof Error ? `${error.stack}\n` : String(error),
    0o600,
  );
  report('failed', {
    kind: error instanceof ApiError ? error.code : 'probe-assertion',
    detailsRetainedPrivately: true,
  });
  process.exitCode = 1;
} finally {
  for (const entry of accepted)
    await service.archive({ target: entry.receipt.target }).catch(() => {});
  for (const name of await listSessionNames(m)) await killSession(m, name).catch(() => {});
  daemon.kill('SIGTERM');
  await daemon.exited;
  await local.close();
  report('cleanup', {
    remainingManagedPanes: (await listSessionNames(m)).size,
    evidenceRetained: true,
  });
}
