#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readOwnedCodexStatus } from '../src/agent/codex/ownedStatus.ts';
import { MachineConfigSchema } from '../src/config/schema.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { controlSocket } from '../src/control/path.ts';
import {
  CCMUX_CONTROL_SERVICE_INGRESS_PATH,
  CCMUX_CONTROL_SERVICE_PREFIX,
  CCMUX_CONTROL_SERVICE_REVISION,
  ControlServiceOperationSchema,
  createCcmuxControlServiceClient,
} from '../src/control/serviceDescriptor.ts';
import { hasSession, killSession, newSession } from '../src/tmux/tmux.ts';

const configArgument = process.argv[2];
if (
  configArgument === undefined ||
  !basename(dirname(configArgument)).startsWith('ccmux-owned-probe-')
)
  throw new Error('Pass an isolated owned-runtime probe machine.json');
const config = configArgument;
const root = dirname(config);
const cli = process.argv[3] ?? join(process.cwd(), 'src/cli.ts');
const recipeId = 'input-policy';
const revision = 'r1';
const requestId = crypto.randomUUID();
const sessionName = `input-${crypto.randomUUID().slice(0, 8)}`;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const base = MachineConfigSchema.parse(JSON.parse(readFileSync(config, 'utf8')));
check(
  base.stateDir === join(root, 'state') && base.tmuxSocket?.startsWith('ccmux-owned-'),
  'probe is not isolated',
);
check(
  base.telegram === undefined && Object.keys(base.fleet ?? {}).length === 0,
  'probe has external delivery configured',
);
const definition = {
  revision,
  flags: ['-c', 'model="gpt-5.6-luna"'],
  environment: [],
  capabilities: ['input-requests'],
  collaborationMode: 'plan' as const,
};
const activeMachine = MachineConfigSchema.parse({
  ...base,
  launchRecipes: { ...base.launchRecipes, [recipeId]: definition },
});

const environment: Record<string, string> = {
  CCMUX_CONFIG: config,
  CCMUX_STATE_DIR: activeMachine.stateDir,
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

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}

async function command(args: string[], timeoutMs = 150_000): Promise<string> {
  const child = Bun.spawn([process.execPath, '--no-env-file', cli, ...args], {
    cwd: root,
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${stderr}\n${stdout}`);
  return stdout;
}

async function restartDaemon(): Promise<void> {
  await killSession(activeMachine, 'probe-daemon');
  await waitFor(
    'old daemon stopped',
    async () => !(await hasSession(activeMachine, 'probe-daemon')),
    10_000,
  );
  await Bun.sleep(300);
  await newSession(
    activeMachine,
    'probe-daemon',
    root,
    [process.execPath, '--no-env-file', cli, 'daemon'],
    environment,
  );
  await waitFor('control service restarted', async () => {
    try {
      const response = await fetch('http://ccmux.local/control/sessions', {
        unix: controlSocket(activeMachine),
      });
      return response.ok;
    } catch {
      return false;
    }
  });
}

await Bun.write(config, `${JSON.stringify(activeMachine, null, 2)}\n`);
await restartDaemon();

const remote = createCcmuxControlServiceClient(async (url, init) => {
  const route = new URL(String(url));
  const operation = ControlServiceOperationSchema.parse(
    route.pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
  );
  const payload = typeof init?.body === 'string' ? init.body : '{}';
  return fetch(`http://ccmux.local${CCMUX_CONTROL_SERVICE_INGRESS_PATH}`, {
    unix: controlSocket(activeMachine),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      id: crypto.randomUUID(),
      caller: activeMachine.rcPrefix,
      service: 'ccmux.control',
      revision: CCMUX_CONTROL_SERVICE_REVISION,
      operation,
      payload,
    }),
  });
});

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    check(
      typeof error === 'object' && error !== null && 'code' in error && error.code === code,
      `Expected ${code}, got ${String(error)}`,
    );
    return;
  }
  throw new Error(`Expected ${code}, call succeeded`);
}

async function requestAndAnswer(
  target: Awaited<ReturnType<typeof remote.create>>['target'],
  marker: string,
) {
  const before = await remote.native({ target, cursor: null });
  await remote.message({
    target,
    messageId: crypto.randomUUID(),
    defer: false,
    notBefore: null,
    task: null,
    body: `Use native request_user_input exactly once to ask me to choose Red or Blue. Wait for my answer, then reply exactly ${marker}. Do not use tools or contact other sessions.`,
  });
  let frame = await remote.native({
    target,
    cursor: { generation: before.generation, sequence: before.sequence },
  });
  const inputDeadline = Date.now() + 90_000;
  while (!frame.pending.some((request) => request.kind === 'input')) {
    check(Date.now() < inputDeadline, 'Timed out: native input request');
    await Bun.sleep(150);
    frame = await remote.native({
      target,
      cursor: { generation: before.generation, sequence: before.sequence },
    });
  }
  const input = frame.pending.find((request) => request.kind === 'input');
  check(input !== undefined && input.questions.length > 0, 'exact input request missing');
  const answers = Object.fromEntries(
    input.questions.map((question) => [question.id, [question.options?.[0]?.label ?? 'Red']]),
  );
  await expectCode(
    () =>
      remote.respond({
        target,
        operationId: crypto.randomUUID(),
        generation: crypto.randomUUID(),
        requestId: input.requestId,
        kind: 'input',
        decision: null,
        answers,
      }),
    'STALE_REQUEST',
  );
  await expectCode(
    () =>
      remote.respond({
        target,
        operationId: crypto.randomUUID(),
        generation: frame.generation,
        requestId: `${input.requestId}-wrong`,
        kind: 'input',
        decision: null,
        answers,
      }),
    'STALE_REQUEST',
  );
  await expectCode(
    () =>
      remote.respond({
        target,
        operationId: crypto.randomUUID(),
        generation: frame.generation,
        requestId: input.requestId,
        kind: 'approval',
        decision: 'accept',
        answers: null,
      }),
    'STALE_REQUEST',
  );
  await expectCode(
    () =>
      remote.respond({
        target,
        operationId: crypto.randomUUID(),
        generation: frame.generation,
        requestId: input.requestId,
        kind: 'input',
        decision: null,
        answers: { wrong: ['Red'] },
      }),
    'STALE_REQUEST',
  );
  const operationId = crypto.randomUUID();
  const receipt = await remote.respond({
    target,
    operationId,
    generation: frame.generation,
    requestId: input.requestId,
    kind: 'input',
    decision: null,
    answers,
  });
  check(receipt.outcome === 'submitted', 'exact input answer was not submitted');
  check(
    (
      await remote.respond({
        target,
        operationId,
        generation: frame.generation,
        requestId: input.requestId,
        kind: 'input',
        decision: null,
        answers,
      })
    ).outcome === 'submitted',
    'identical input response retry lost its receipt',
  );
  const changedAnswers = Object.fromEntries(Object.entries(answers).map(([id]) => [id, ['Blue']]));
  await expectCode(
    () =>
      remote.respond({
        target,
        operationId,
        generation: frame.generation,
        requestId: input.requestId,
        kind: 'input',
        decision: null,
        answers: changedAnswers,
      }),
    'IDEMPOTENCY_CONFLICT',
  );
  await waitFor(
    'answered turn terminal success',
    async () => {
      const current = await remote.get({ target });
      return current.state === 'idle' && current.turn?.status === 'completed';
    },
    120_000,
  );
  const after = await remote.native({ target, cursor: null });
  check(
    [...after.baseline, ...after.records].some(
      (item) => item.kind === 'assistant' && item.text?.includes(marker),
    ),
    'terminal assistant response did not contain the exact marker',
  );
  return {
    turnId: input.turnId,
    requestId: input.requestId,
    operationId,
    generation: frame.generation,
  };
}

let target: Awaited<ReturnType<typeof remote.create>>['target'] | null = null;
let archived = false;
try {
  const createInput = {
    requestId,
    name: sessionName,
    workspace: root,
    flags: [],
    launchRecipe: { id: recipeId, revision },
  };
  const created = await remote.create(createInput);
  target = created.target;
  check(
    created.launchRecipe?.collaborationMode === 'plan' &&
      created.launchRecipe.capabilities.includes('input-requests'),
    'create receipt omitted safe collaboration policy metadata',
  );
  const session = loadSessions(activeMachine).find((item) => item.name === sessionName);
  check(
    session !== undefined && session.uuid === target.threadId,
    'managed registry identity missing',
  );
  await waitFor(
    'managed policy session idle',
    () => readOwnedCodexStatus(activeMachine, session).snapshot?.state === 'idle',
  );
  const first = await requestAndAnswer(target, 'INPUT_ROUND_ONE_DONE');

  const beforeRestart = readOwnedCodexStatus(activeMachine, session).snapshot;
  check(beforeRestart !== null, 'provider restart baseline missing');
  await command(['restart', sessionName]);
  await waitFor('same identity after provider restart', () => {
    const next = readOwnedCodexStatus(activeMachine, session).snapshot;
    return (
      next !== null &&
      next.providerPid !== beforeRestart.providerPid &&
      next.generation !== beforeRestart.generation &&
      next.state === 'idle'
    );
  });
  check(
    loadSessions(activeMachine).find((item) => item.name === sessionName)?.uuid === target.threadId,
    'provider restart changed native identity',
  );

  await restartDaemon();
  const retried = await remote.create(createInput);
  check(
    retried.duplicate &&
      retried.target.threadId === target.threadId &&
      retried.launchRecipe?.digest === created.launchRecipe.digest &&
      retried.launchRecipe.collaborationMode === 'plan',
    'daemon retry changed identity or collaboration policy',
  );
  const second = await requestAndAnswer(target, 'INPUT_ROUND_TWO_DONE');
  const row = await remote.get({ target });
  check(
    row.launchRecipe?.digest === created.launchRecipe.digest &&
      row.launchRecipe.collaborationMode === 'plan',
    'status projection changed collaboration policy metadata',
  );
  const archive = await remote.archive({ target });
  archived = archive.archived;
  console.log(
    JSON.stringify({
      ok: true,
      policy: row.launchRecipe,
      sameIdentity: true,
      first,
      second,
      providerRestart: true,
      daemonRestart: true,
      staleRefusals: true,
      exactResponse: true,
      archived,
    }),
  );
} finally {
  if (target !== null && !archived) await remote.archive({ target }).catch(() => {});
}
