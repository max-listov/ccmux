#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  prepareManagedCodexTurn,
  resumeCodexAppThreadContext,
  startCodexAppTurn,
} from '../src/agent/codex/appServer.ts';
import { connectOwnedCodex } from '../src/agent/codex/ownedRpc.ts';
import { readOwnedCodexStatus } from '../src/agent/codex/ownedStatus.ts';
import { codexTextInput } from '../src/agent/codex/turnInput.ts';
import { loadMachineConfig } from '../src/config/machine.ts';
import { MachineConfigSchema } from '../src/config/schema.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { controlSocket } from '../src/control/path.ts';
import { createInjectedControlClient } from '../src/control/transportBoundary.ts';
import { killSession, newSession } from '../src/tmux/tmux.ts';
import type { ManagedPeer, Session } from '../src/types.ts';
import { localControlFetch } from './control-client.ts';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const root = realpathSync(mkdtempSync('/tmp/ccmux-owned-probe-'));
const config = join(root, 'machine.json');
const cli = resolve(process.argv[2] ?? 'src/cli.ts');
const commandPrefix =
  cli.endsWith('.ts') || cli.endsWith('.js') ? [process.execPath, '--no-env-file', cli] : [cli];
// An extracted, checksum-verified published package can prove the installed client boundary too.
const publishedClient = process.argv[3];
const makeServiceClient: typeof createInjectedControlClient =
  publishedClient === undefined
    ? createInjectedControlClient
    : (await import(resolve(publishedClient))).createInjectedControlClient;
const machine = MachineConfigSchema.parse({
  ...loadMachineConfig(),
  stateDir: join(root, 'state'),
  rcPrefix: 'probe',
  tmuxSocket: `ccmux-owned-${root.split('-').at(-1)}`,
  fleet: {},
  remoteTransport: { peers: [] },
  autoUpdate: false,
  chatEnabled: true,
  sessionEvents: true,
  remoteControl: false,
  telegram: undefined,
  extraFlags: [],
  codexCorrelationTimeoutMs: 45_000,
  launchRecipes: {
    native: {
      revision: '1',
      flags: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
      environment: [],
      capabilities: ['input-requests'],
      collaborationMode: 'plan',
    },
  },
});
const environment: Record<string, string> = {
  CCMUX_CONFIG: config,
  CCMUX_STATE_DIR: machine.stateDir,
  CCMUX_CACHE_DIR: join(root, 'cache'),
  CCMUX_DATA_DIR: join(root, 'data'),
};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && environment[key] === undefined) environment[key] = value;
for (const key of [
  'CCMUX_SESSION',
  'CCMUX_CHAT_CREDENTIAL',
  'CODEX_THREAD_ID',
  'CODEX_APP_TOOLS_PIPE_PATH',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
])
  delete environment[key];
await Bun.write(config, JSON.stringify(machine));
chmodSync(config, 0o600);

async function until(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeout = 120_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}
async function restartDaemon() {
  await killSession(machine, 'probe-daemon');
  await newSession(machine, 'probe-daemon', root, [...commandPrefix, 'daemon'], environment);
  await until(
    'control service',
    async () => {
      try {
        return (
          await fetch('http://ccmux.local/control/sessions', { unix: controlSocket(machine) })
        ).ok;
      } catch {
        return false;
      }
    },
    15_000,
  );
}
async function command(args: string[]) {
  const child = Bun.spawn([...commandPrefix, ...args], {
    cwd: root,
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  check(code === 0, `Command failed (${code}): ${out} ${err}`);
}
const remote = makeServiceClient(localControlFetch(controlSocket(machine), machine.rcPrefix));
async function idle(target: ManagedPeer) {
  await until('native idle', async () => {
    try {
      return (await remote['session.get']({ target })).state === 'idle';
    } catch {
      return false;
    }
  });
}
async function refused(run: () => Promise<unknown>, code: string) {
  try {
    await run();
  } catch (error) {
    check(
      typeof error === 'object' && error !== null && 'code' in error && error.code === code,
      String(error),
    );
    return;
  }
  throw new Error(`Expected ${code}`);
}
async function toolTurn(target: ManagedPeer, session: Session, differentPreset?: string) {
  await idle(target);
  const marker = `READ_${crypto.randomUUID().replaceAll('-', '')}`;
  const before = await remote['native.read']({ target, cursor: null });
  const body = `Use the native shell tool to run pwd in this workspace (read only), then reply exactly ${marker}. Do not edit files or contact any sessions.`;
  if (differentPreset !== undefined) {
    const rpc = await connectOwnedCodex(machine, session, { signal: AbortSignal.timeout(15_000) });
    try {
      const context = await resumeCodexAppThreadContext(rpc, target.threadId);
      const policy = await prepareManagedCodexTurn(
        {
          close() {},
          request: async (method, params) => {
            const response = await rpc.request(method, params);
            if (method !== 'collaborationMode/list') return response;
            const presets = z
              .object({ data: z.array(z.object({ mode: z.string().nullable() }).passthrough()) })
              .parse(response);
            return { data: presets.data.map((preset) => ({ ...preset, model: differentPreset })) };
          },
        },
        machine,
        session,
        context,
      );
      check(
        policy?.collaborationMode?.settings.model === session.modelSelection?.model,
        'Preset replaced model',
      );
      await startCodexAppTurn(
        rpc,
        target.threadId,
        crypto.randomUUID(),
        codexTextInput(body),
        policy,
      );
    } finally {
      rpc.close();
    }
  } else await remote['message.send']({ target, messageId: crypto.randomUUID(), body });
  await until('tool turn', async () => {
    const frame = await remote['native.read']({
      target,
      cursor: { generation: before.generation, sequence: before.sequence },
    });
    const records = [...frame.baseline, ...frame.records];
    return (
      records.some((item) => item.kind === 'assistant' && item.text?.includes(marker)) &&
      records.some(
        (item) =>
          item.kind === 'tool' && item.text === 'commandExecution' && item.status === 'completed',
      )
    );
  });
  await idle(target);
  const rpc = await connectOwnedCodex(machine, session);
  try {
    const context = await resumeCodexAppThreadContext(rpc, target.threadId);
    check(
      context.model === session.modelSelection?.model &&
        context.modelProvider === session.modelSelection?.provider,
      'Native execution changed selected provider/model',
    );
  } finally {
    rpc.close();
  }
}
const targets: ManagedPeer[] = [];
try {
  await restartDaemon();
  check(loadSessions(machine).length === 0, 'Inventory not empty');
  const catalog = await remote['model.list']({});
  const profiled = await remote['model.list']({ launchRecipe: { id: 'native', revision: '1' } });
  check(
    catalog.target === undefined &&
      catalog.source.kind === 'host' &&
      catalog.source.provider === 'openai',
    'Catalog source is wrong',
  );
  check(
    profiled.data.length > 1 && loadSessions(machine).length === 0,
    'Catalog needs a conversation',
  );
  const page = await remote['model.list']({ limit: 1 });
  check(page.nextCursor !== null, 'Pagination fixture too small');
  const next = await remote['model.list']({ limit: 1, cursor: page.nextCursor });
  check(page.data[0]?.id !== next.data[0]?.id, 'Pagination repeated a model');
  const directory = await remote['directory.list']({ path: root });
  check(
    directory.path === root && directory.entries.some((entry) => entry.name === 'machine.json'),
    'Directory service failed',
  );
  const available = profiled.data.map((model) => model.model ?? model.id);
  const selected = [
    available.find((id) => id.endsWith('luna')),
    available.find((id) => id.endsWith('mini')),
  ];
  const choices = [
    ...new Set([...selected.filter((id): id is string => id !== undefined), ...available]),
  ].slice(0, 2);
  check(choices.length === 2, 'Need two native models for acceptance');
  console.log(
    JSON.stringify({
      phase: 'empty-inventory-catalog',
      models: catalog.data.length,
      choices,
      directory: true,
    }),
  );
  const receipts = [];
  await refused(
    () =>
      remote['session.create']({
        requestId: crypto.randomUUID(),
        name: 'unavailable',
        workspace: root,
        flags: [],
        modelSelection: { provider: 'openai', model: 'fixture-model-not-in-catalog' },
      }),
    'MODEL_UNAVAILABLE',
  );
  check(loadSessions(machine).length === 0, 'Invalid selection created a registry row');
  for (const [index, model] of choices.entries()) {
    const input = {
      requestId: crypto.randomUUID(),
      name: `model-${index}`,
      workspace: root,
      flags: [],
      launchRecipe: { id: 'native', revision: '1' },
      modelSelection: { provider: 'openai', model },
    };
    const created = await remote['session.create'](input);
    targets.push(created.target);
    const retried = await remote['session.create'](input);
    check(
      retried.duplicate && retried.target.threadId === created.target.threadId,
      'One-writer retry failed',
    );
    await refused(
      () =>
        remote['session.create']({
          ...input,
          modelSelection: { provider: 'openai', model: 'different' },
        }),
      'IDEMPOTENCY_CONFLICT',
    );
    const session = loadSessions(machine).find(
      (session) => session.uuid === created.target.threadId,
    );
    check(session !== undefined, 'Native registry missing');
    await toolTurn(created.target, session, index === 0 ? choices[1] : undefined);
    receipts.push({ input, created, session });
    console.log(
      JSON.stringify({
        phase: 'selected-model-tool-turn',
        model,
        differingPresetProbe: index === 0,
      }),
    );
  }
  check(
    receipts[0]?.created.launchRecipe?.digest === receipts[1]?.created.launchRecipe?.digest,
    'Profiles differ',
  );
  const first = receipts[0];
  check(first !== undefined, 'First create receipt is missing');
  await idle(first.created.target);
  const inputMarker = `INPUT_${crypto.randomUUID().replaceAll('-', '')}`;
  await remote['message.send']({
    target: first.created.target,
    messageId: crypto.randomUUID(),
    body: `Ask one native request_user_input question with two choices Red and Blue. Wait for the answer, then reply exactly ${inputMarker}. No other tools or messages.`,
  });
  let inputFrame = await remote['native.read']({ target: first.created.target, cursor: null });
  await until('Plan native input request', async () => {
    inputFrame = await remote['native.read']({ target: first.created.target, cursor: null });
    return inputFrame.pending.some((request) => request.kind === 'input');
  });
  const pending = inputFrame.pending.find((request) => request.kind === 'input');
  check(pending !== undefined, 'Expected native input request is missing');
  const answers = Object.fromEntries(
    pending.questions.map((question) => [question.id, [question.options?.[0]?.label ?? 'Red']]),
  );
  const answer = {
    target: first.created.target,
    operationId: crypto.randomUUID(),
    generation: inputFrame.generation,
    requestId: pending.requestId,
    kind: 'input' as const,
    answers,
  };
  await refused(
    () => remote['native.respond']({ ...answer, generation: crypto.randomUUID() }),
    'STALE_REQUEST',
  );
  check(
    (await remote['native.respond'](answer)).outcome === 'submitted',
    'Exact input response failed',
  );
  await until('input answer completed', async () =>
    (await remote['native.read']({ target: first.created.target, cursor: null })).baseline.some(
      (item) => item.kind === 'assistant' && item.text?.includes(inputMarker),
    ),
  );
  await idle(first.created.target);
  const before = readOwnedCodexStatus(machine, first.session).snapshot;
  check(before !== null, 'Restart baseline missing');
  await command(['restart', first.session.name]);
  await until('new provider generation', () => {
    const snapshot = readOwnedCodexStatus(machine, first.session).snapshot;
    return (
      snapshot !== null &&
      snapshot.providerPid !== before.providerPid &&
      snapshot.generation !== before.generation
    );
  });
  await restartDaemon();
  const retry = await remote['session.create'](first.input);
  check(
    retry.duplicate &&
      retry.target.threadId === first.created.target.threadId &&
      retry.modelSelection?.model === first.input.modelSelection.model,
    'Restart changed selection/identity',
  );
  await toolTurn(retry.target, first.session);
  const model = (await remote['session.get']({ target: retry.target })).nativeSelection?.model;
  check(model?.model === first.input.modelSelection.model, 'Status lost model selection');
  const native = await remote['native.read']({ target: retry.target, cursor: null });
  check(native.nativeSelection?.model.model === model.model, 'Native projection lost selection');
  const waited = await remote['session.wait']({ target: retry.target, timeoutMs: 10_000 });
  check(
    ['idle', 'completed'].includes(waited.outcome),
    'Wait did not see a terminal native boundary',
  );
  const plain = await remote['session.create']({
    requestId: crypto.randomUUID(),
    name: 'default-native',
    workspace: root,
    flags: ['-m', first.input.modelSelection.model],
  });
  targets.push(plain.target);
  check(
    plain.launchRecipe === undefined && plain.modelSelection === undefined,
    'Default create synthesized selection',
  );
  await idle(plain.target);
  for (const target of targets)
    check((await remote['session.archive']({ target })).archived, 'Archive failed');
  console.log(
    JSON.stringify({
      ok: true,
      publishedClient: publishedClient !== undefined,
      models: choices,
      recipeCount: 1,
      emptyInventoryCatalog: true,
      directory: true,
      nativeToolTurns: 3,
      differingPreset:
        'injected into real native capability response; real turn retained selection',
      retryOneWriter: true,
      changedSelectionRefused: true,
      unavailableBeforeWriter: true,
      exactPlanInput: true,
      wait: waited.outcome,
      defaultCreate: true,
      providerAndDaemonRestart: true,
      archived: targets.length,
      identityHash: createHash('sha256')
        .update(first.created.target.threadId)
        .digest('hex')
        .slice(0, 16),
    }),
  );
} finally {
  for (const target of targets) await remote['session.archive']({ target }).catch(() => {});
  await killSession(machine, 'probe-daemon');
  console.log(JSON.stringify({ evidenceDirectory: root }));
}
