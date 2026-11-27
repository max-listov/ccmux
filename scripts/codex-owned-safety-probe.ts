#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { findCodexTurnByClientId } from 'stitchkit/agent-executor/codex';
import { resumeCodexAppThreadContext } from '../src/agent/codex/appServer.ts';
import { ownedCodexSocket } from '../src/agent/codex/owned/paths.ts';
import {
  codexExecutorProfile,
  createCodexSocketDriver,
  OWNED_CODEX_MAX_FRAME_BYTES,
} from '../src/agent/codex/owned/rpc.ts';
import { readOwnedCodexStatus } from '../src/agent/codex/owned/status.ts';
import { startOwnedCodexTurn } from '../src/agent/codex/owned/thread.ts';
import { inspectNativeCodexInput } from '../src/agent/codex/pane.ts';
import { codexTextInput } from '../src/agent/codex/turnInput.ts';
import { loadCursors } from '../src/chat/cursors.ts';
import { managedPeer, managedPeerKey } from '../src/chat/identity.ts';
import { loadLedger } from '../src/chat/ledger.ts';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { loadSessions } from '../src/session/registry.ts';
import { capturePaneStyled, sendKeysLiteral, sendKeysNamed } from '../src/tmux/tmux.ts';

const config = process.argv[2];
if (config === undefined || !basename(dirname(config)).startsWith('stitchmux-owned-probe-'))
  throw new Error("Pass the isolated probe's machine.json");
const root = dirname(config),
  cli = process.argv[3] ?? join(process.cwd(), 'src/cli.ts');
const m = MachineConfigSchema.parse(JSON.parse(readFileSync(config, 'utf8')));
if (
  m.stateDir !== join(root, 'state') ||
  m.telegram !== undefined ||
  Object.keys(m.fleet ?? {}).length
)
  throw new Error('Probe is not isolated');
const session = loadSessions(m).find((s) => s.name === 'agent-a');
if (session === undefined) throw new Error('Missing probe session');
const env: Record<string, string> = {
  STITCHMUX_CONFIG: config,
  STITCHMUX_STATE_DIR: m.stateDir,
  STITCHMUX_CACHE_DIR: join(root, 'cache'),
};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && env[key] === undefined) env[key] = value;
for (const key of [
  'STITCHMUX_SESSION',
  'STITCHMUX_CHAT_CREDENTIAL',
  'CODEX_THREAD_ID',
  'CODEX_APP_TOOLS_PIPE_PATH',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
])
  delete env[key];
function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
const current = () => readOwnedCodexStatus(m, session).snapshot;
const target = managedPeer(m.rcPrefix, session);
const key = managedPeerKey(target);
const client = createControlClient({ socket: controlSocket(m) });
async function command(args: string[], expected = 0, timeout = 150_000) {
  const p = Bun.spawn([process.execPath, '--no-env-file', cli, ...args], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => p.kill(), timeout);
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  clearTimeout(timer);
  check(code === expected, `${args[0]}: exit ${code}; ${out} ${err}`);
  return out;
}
async function until(label: string, test: () => boolean, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (!test()) {
    check(Date.now() < end, `Timed out: ${label}`);
    await Bun.sleep(200);
  }
}
function progress(phase: string, evidence: unknown) {
  console.log(JSON.stringify({ phase, evidence }));
}
async function expectCode(run: () => Promise<unknown>, code: string) {
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
check(current()?.state === 'idle', 'Known positive baseline must be live idle');
check(
  inspectNativeCodexInput(await capturePaneStyled(m, session.name, 40)).state === 'deliverable',
  'Composer must start empty',
);
await command(['wait', session.name, '--timeout', '10']);

const token = `safety-${crypto.randomUUID()}`;
const before = current()?.turn?.id;
await sendKeysLiteral(m, session.name, 'UNSENT_NATIVE_PROBE');
await Bun.sleep(300);
check(
  inspectNativeCodexInput(await capturePaneStyled(m, session.name, 40)).state === 'input-busy',
  'Real partial input not observed',
);
await command([
  'msg',
  session.name,
  `${token} partial gate: reply PARTIAL_DONE only. Do not message anyone.`,
]);
await command(['wait', session.name, '--timeout', '2'], 2);
check(current()?.turn?.id === before, 'Partial input was submitted/overwritten');
check(loadCursors(m).pickups[key] === undefined, 'Partial gate claimed pickup');
await sendKeysNamed(m, session.name, 'C-u');
await command(['wait', session.name, '--timeout', '120']);
progress('partial-input', { preserved: true, completedAfterClear: true, threadId: session.uuid });

const openProbeSession = () =>
  createCodexSocketDriver(ownedCodexSocket(m, session.name), {
    maxFrameBytes: OWNED_CODEX_MAX_FRAME_BYTES,
  }).open({
    profile: codexExecutorProfile(m, session),
    cwd: session.dir,
    nativeThreadId: session.uuid,
  });

let rpc = await openProbeSession();
try {
  const nativeBeforeApproval = await client['native.read']({ target, cursor: null });
  const approvalTurn = await startOwnedCodexTurn(
    rpc,
    crypto.randomUUID(),
    codexTextInput(
      'This is an authorized approval-boundary test. Request permission to run the harmless command printf APPROVAL_TEST with sandbox_permissions=require_escalated and justification=approval boundary test. Do not use a non-escalated alternative; wait for the actual approval response. Do not modify files or message anyone.',
    ),
  );
  await until('actual native approval', () => current()?.state === 'waiting-approval');
  await command([
    'msg',
    session.name,
    `${token} approval gate: reply APPROVAL_GATE_DONE only. Do not message anyone.`,
    '--defer',
  ]);
  await command(['wait', session.name, '--timeout', '2'], 2);
  check(
    current()?.turn?.id === approvalTurn && current()?.state === 'waiting-approval',
    'Approval was bypassed',
  );
  check(loadCursors(m).pickups[key] === undefined, 'Approval gate claimed pickup');
  const approvalFrame = await client['native.read']({
    target,
    cursor: {
      generation: nativeBeforeApproval.generation,
      sequence: nativeBeforeApproval.sequence,
    },
  });
  const approval = approvalFrame.pending.find(
    (request) => request.kind === 'approval' && request.turnId === approvalTurn,
  );
  check(approval !== undefined, 'Exact native approval request is unavailable');
  check(approval.decisions.includes('accept'), 'Exact native approval decision is unavailable');
  await expectCode(
    () =>
      client['native.respond']({
        target,
        operationId: crypto.randomUUID(),
        generation: crypto.randomUUID(),
        requestId: approval.requestId,
        kind: 'approval',
        decision: 'accept',
        answers: null,
      }),
    'STALE_REQUEST',
  );
  const approvalOperation = crypto.randomUUID();
  const approvalReceipt = await client['native.respond']({
    target,
    operationId: approvalOperation,
    generation: approvalFrame.generation,
    requestId: approval.requestId,
    kind: 'approval',
    decision: 'accept',
    answers: null,
  });
  check(approvalReceipt.outcome === 'submitted', 'Approval response remained uncertain');
  check(
    (
      await client['native.respond']({
        target,
        operationId: approvalOperation,
        generation: approvalFrame.generation,
        requestId: approval.requestId,
        kind: 'approval',
        decision: 'accept',
        answers: null,
      })
    ).outcome === 'submitted',
    'Approval retry did not return its durable receipt',
  );
  await expectCode(
    () =>
      client['native.respond']({
        target,
        operationId: approvalOperation,
        generation: approvalFrame.generation,
        requestId: approval.requestId,
        kind: 'approval',
        decision: 'decline',
        answers: null,
      }),
    'IDEMPOTENCY_CONFLICT',
  );
  await command(['wait', session.name, '--timeout', '120']);
  const nativeAfterApproval = await client['native.read']({
    target,
    cursor: {
      generation: nativeBeforeApproval.generation,
      sequence: nativeBeforeApproval.sequence,
    },
  });
  const nativeRecords = [...nativeAfterApproval.baseline, ...nativeAfterApproval.records];
  const nativeKinds = new Set(nativeRecords.map((item) => item.kind));
  for (const kind of ['tool', 'assistant', 'terminal'] as const) {
    check(nativeKinds.has(kind), `Native turn projection missed ${kind}`);
  }
  check(
    nativeRecords.every((item, index, items) => {
      const previous = items[index - 1];
      return index === 0 || (previous !== undefined && item.sequence > previous.sequence);
    }),
    'Native item projection is not strictly ordered',
  );
  progress('approval-exact-response', {
    approvalTurn,
    requestId: approval.requestId,
    operationId: approvalOperation,
    orderedKinds: [...nativeKinds],
    subsequentMessageCompleted: true,
  });

  const interrupted = await startOwnedCodexTurn(
    rpc,
    crypto.randomUUID(),
    codexTextInput(
      'Run sleep 30, then reply INTERRUPTION_TEST_DONE. Do not contact anyone or change files.',
    ),
  );
  await until(
    'real active turn before interruption',
    () => current()?.turn?.id === interrupted && current()?.state === 'working',
  );
  await rpc.interruptTurn({ threadId: session.uuid, turnId: interrupted });
  const settled = await command(['wait', session.name, '--timeout', '30']);
  check(settled.includes('interrupted'), 'Interrupted turn reported as completed');
  await command([
    'msg',
    session.name,
    `${token} after interruption: reply INTERRUPT_RECOVERED only.`,
  ]);
  await command(['wait', session.name, '--timeout', '120']);
  const last = loadLedger(m).find((msg) => msg?.body.includes(`${token} after interruption`));
  check(last, 'Missing recovery message');
  check(
    (await findCodexTurnByClientId(rpc, { threadId: session.uuid, clientId: last.id }))?.status ===
      'completed',
    'Interrupted pickup did not recover',
  );
  progress('interrupted-pickup', { interrupted, settled: settled.trim(), recovered: last.id });

  const beforeRestart = current();
  check(beforeRestart !== null, 'Missing restart baseline');
  await rpc.close();
  await command(['restart', session.name]);
  await until('same UUID, new provider after restart', () => {
    const next = current();
    return (
      next !== null &&
      next.providerPid !== beforeRestart.providerPid &&
      next.generation !== beforeRestart.generation &&
      next.state === 'idle'
    );
  });
  check(
    loadSessions(m).find((s) => s.name === session.name)?.uuid === session.uuid,
    'Restart changed identity',
  );
  const nativeAfterRestart = await client['native.read']({
    target,
    cursor: {
      generation: nativeBeforeApproval.generation,
      sequence: nativeAfterApproval.sequence,
    },
  });
  check(
    nativeAfterRestart.reset === 'generation',
    'Provider restart did not emit an explicit native resync boundary',
  );
  rpc = await openProbeSession();
  const resumed = await resumeCodexAppThreadContext(rpc, session.uuid);
  check(
    resumed.thread.id === session.uuid && resumed.model !== undefined,
    'Provider resumed a different identity',
  );
  progress('restart-resume', {
    threadId: session.uuid,
    beforePid: beforeRestart.providerPid,
    afterPid: current()?.providerPid,
  });

  // A resumed provider can retain stale mode guidance despite reporting Plan in turn_context.
  // Establish a real Default -> Plan transition, rather than treating a repeated mode as a reset.
  const baselineId = crypto.randomUUID();
  const baseline = await rpc.startTurn({
    turnId: baselineId,
    clientId: baselineId,
    collaborationMode: {
      mode: 'default',
      settings: {
        model: resumed.model,
        reasoning_effort: 'low',
        developer_instructions:
          'The current collaboration mode is Default. Reply MODE_BASELINE_READY only for this isolated test.',
      },
    },
    input: [{ type: 'text', text: 'Reply MODE_BASELINE_READY only.' }],
  });
  await until(
    'known Default-mode baseline',
    () =>
      current()?.turn?.id === baseline.nativeTurnId &&
      current()?.turn?.status === 'completed' &&
      current()?.state === 'idle',
  );
  const responseId = crypto.randomUUID();
  const response = await rpc.startTurn({
    turnId: responseId,
    clientId: responseId,
    collaborationMode: {
      mode: 'plan',
      settings: {
        model: resumed.model,
        reasoning_effort: 'low',
        developer_instructions:
          'The current collaboration mode is Plan. request_user_input is available. For this isolated boundary test, call request_user_input once with Red and Blue options, then wait for the user. Do not perform other work.',
      },
    },
    input: [
      {
        type: 'text',
        text: 'Use request_user_input to ask me to choose Red or Blue. This is a user-input boundary test. Do not decide for me or do other work.',
      },
    ],
  });
  await until('actual native input wait', () => {
    const state = current();
    check(
      state?.turn?.id !== response.nativeTurnId || state.turn.status === 'inProgress',
      'Native input-test turn ended without requesting input; inspect its actual provider response',
    );
    return state?.state === 'waiting-input';
  });
  await command([
    'msg',
    session.name,
    `${token} input gate: reply INPUT_GATE_DONE only.`,
    '--defer',
  ]);
  await command(['wait', session.name, '--timeout', '2'], 2);
  check(
    current()?.turn?.id === response.nativeTurnId && current()?.state === 'waiting-input',
    'Input request was bypassed',
  );
  const inputFrame = await client['native.read']({ target, cursor: null });
  const input = inputFrame.pending.find(
    (request) => request.kind === 'input' && request.turnId === response.nativeTurnId,
  );
  check(input && input.questions.length > 0, 'Exact native input request is unavailable');
  await expectCode(
    () =>
      client['native.respond']({
        target,
        operationId: crypto.randomUUID(),
        generation: inputFrame.generation,
        requestId: `${input.requestId}-stale`,
        kind: 'input',
        decision: null,
        answers: Object.fromEntries(
          input.questions.map((question) => [question.id, [question.options?.[0]?.label ?? 'Red']]),
        ),
      }),
    'STALE_REQUEST',
  );
  const inputOperation = crypto.randomUUID();
  const answers = Object.fromEntries(
    input.questions.map((question) => [question.id, [question.options?.[0]?.label ?? 'Red']]),
  );
  const inputReceipt = await client['native.respond']({
    target,
    operationId: inputOperation,
    generation: inputFrame.generation,
    requestId: input.requestId,
    kind: 'input',
    decision: null,
    answers,
  });
  check(inputReceipt.outcome === 'submitted', 'Input response remained uncertain');
  await command(['wait', session.name, '--timeout', '120']);
  progress('input-exact-response', {
    waitingTurn: response.nativeTurnId,
    requestId: input.requestId,
    operationId: inputOperation,
    answeredQuestionIds: Object.keys(answers),
  });
} finally {
  await rpc.close();
  await client.close();
}
progress('completed-safety-e2e', { threadId: session.uuid, config });
