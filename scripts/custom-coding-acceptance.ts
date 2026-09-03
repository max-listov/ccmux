import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ControlCreateReceipt } from '../src/control/schema.ts';
import { atomicWrite } from '../src/util/atomic.ts';
import {
  check,
  type NativeImageProbe,
  refusal,
  report,
  until,
} from './native-image-steering-fixture.ts';
import { hasExited } from './process-state.ts';

export async function customCoding(p: NativeImageProbe, receipt: ControlCreateReceipt) {
  const { target, registrationGeneration } = receipt;
  const pending = async () =>
    p.service.native({ target }).catch((error) => {
      if (error instanceof Error && 'code' in error && error.code === 'UNAVAILABLE') return null;
      throw error;
    });
  const answer = async (decision: 'accept' | 'decline') => {
    const frame = await pending(),
      request = frame?.pending[0];
    if (!frame || !request) return;
    await p.service.respond({
      target,
      generation: frame.generation,
      requestId: request.requestId,
      operationId: crypto.randomUUID(),
      kind: 'approval',
      decision,
    });
  };
  const complete = async (messageId: string, decision: 'accept' | 'decline' = 'accept') => {
    await until(
      'real Custom coding completion',
      async () => {
        await answer(decision);
        const op = await p.service.messageOperation({ target, registrationGeneration, messageId });
        check(op.evidence?.state !== 'failed', 'Real coding model turn failed');
        return op.evidence?.state === 'completed';
      },
      180_000,
    );
  };
  const send = async (body: string) => {
    const messageId = crypto.randomUUID();
    await p.service.message({ target, messageId, body });
    return messageId;
  };
  const path = join(receipt.workspace, 'coding.txt');
  await atomicWrite(path, 'before', 0o600);
  const digest = createHash('sha256').update('before').digest('hex');
  const messageId = await send(
    `Perform this isolated coding verification in order, using the actual tools: read_file coding.txt; search_files query coding, mode path; edit_file coding.txt with expectedSha256 ${digest}, oldText before, newText after, dryRun false; run_command executable runner args ["--no-env-file","-e","console.log(123)"]; then run_command executable runner args ["--no-env-file","-e","process.exit(7)"]. Exit 7 is intentional: do not retry or fix it. Finally say DONE. No other effects or messages.`,
  );
  await complete(messageId);
  check((await readFile(path, 'utf8')) === 'after', 'Guarded patch effect differs');
  const native = await p.service.native({ target });
  const tools = native.baseline.flatMap((item) => (item.tool ? [item.tool] : []));
  for (const name of ['read_file', 'search_files', 'edit_file'])
    check(
      tools.some((tool) => tool.name === name && tool.outcome === 'succeeded'),
      `Missing real ${name}`,
    );
  check(
    tools.some((tool) => tool.exitCode === 0 && tool.outcome === 'succeeded'),
    'Allowed command failed',
  );
  check(
    tools.some((tool) => tool.exitCode === 7 && tool.outcome === 'failed'),
    'Nonzero tool status was flattened',
  );

  const denied = await send(
    'Call write_file once to create denied.txt with content forbidden, overwrite false. If permission is denied do not retry and do not use a different tool; finish DENIED.',
  );
  await until('signed denial request', async () => (await pending())?.pending.length === 1);
  // session.get is the prepared monitoring projection, not the native event stream.
  // Qualify its next observation of this exact request instead of assuming atomic publication.
  const requestFrame = await p.service.native({ target });
  const requestTurnId = requestFrame.pending[0]?.turnId;
  check(requestTurnId, 'Signed denial request has no exact turn');
  const firstObservation = await p.service.get({ target });
  report('custom-pending-observation', {
    nativeTurnId: requestTurnId,
    preparedTurnId: firstObservation.turn?.id,
    preparedState: firstObservation.state,
    preparedObservedAt: firstObservation.observedAt,
  });
  await until('prepared signed denial state', async () => {
    const state = await p.service.get({ target });
    return state.state === 'waiting-approval' && state.turn?.id === requestTurnId;
  });
  const suspended = await p.service.get({ target }),
    frame = await p.service.native({ target });
  check(suspended.state === 'waiting-approval' && suspended.turn, 'Pending approval state missing');
  await refusal(
    () =>
      p.service.interrupt({
        target,
        generation: frame.generation,
        turnId: suspended.turn?.id ?? '',
      }),
    'TURN_MISMATCH',
  );
  check(
    (await p.service.wait({ target, timeoutMs: 500 })).outcome === 'timeout',
    'Pending approval falsely completed wait',
  );
  const deferred = crypto.randomUUID();
  await p.service.message({
    target,
    messageId: deferred,
    defer: true,
    body: 'Reply DEFERRED only. Do not use tools.',
  });
  const held = await p.service.messageOperation({
    target,
    registrationGeneration,
    messageId: deferred,
  });
  check(held.evidence?.turnId === null, 'Busy deferred input was admitted early');
  await complete(denied, 'decline');
  await complete(deferred);
  check(
    !(await Bun.file(join(receipt.workspace, 'denied.txt')).exists()),
    'Declined tool produced an effect',
  );

  const marker = join(receipt.workspace, 'command-started');
  const effect = join(receipt.workspace, 'late-effect');
  const script = join(receipt.workspace, 'finite-command.ts');
  await atomicWrite(
    script,
    `await Bun.write(${JSON.stringify(marker)}, String(process.pid));\nawait Bun.sleep(20000);\nawait Bun.write(${JSON.stringify(effect)}, 'forbidden');\n`,
    0o600,
  );
  const interrupted = await send(
    `Call run_command once with executable runner, args ["--no-env-file","${script}"]. This is an authorized isolated cancellation test; do not retry if interrupted.`,
  );
  await until('positive running child before cancellation', async () => {
    await answer('accept');
    return Bun.file(marker).exists();
  });
  await until('prepared active command state', async () => {
    const state = await p.service.get({ target });
    const op = await p.service.messageOperation({
      target,
      registrationGeneration,
      messageId: interrupted,
    });
    const runId = op.evidence?.continuations.at(-1)?.turnId ?? op.evidence?.turnId;
    return (
      state.state === 'working' && state.turn?.status === 'inProgress' && state.turn.id === runId
    );
  });
  const active = await p.service.get({ target }),
    activeFrame = await p.service.native({ target });
  check(
    active.state === 'working' && active.turn?.status === 'inProgress',
    'Active turn not observable',
  );
  await p.service.interrupt({ target, generation: activeFrame.generation, turnId: active.turn.id });
  await until(
    'exact interrupted managed operation',
    async () =>
      (await p.service.messageOperation({ target, registrationGeneration, messageId: interrupted }))
        .evidence?.state === 'interrupted',
  );
  const pid = Number(await readFile(marker, 'utf8'));
  // A cancelled child that exits under a parent which is not reaping it becomes a zombie, and the
  // signal probe reports a zombie as running — so this wait watches the state, not the signal.
  await until('cancelled child exited', async () => hasExited(pid));
  check(!(await Bun.file(effect).exists()), 'Cancelled command produced a late effect');
  report('custom-coding-pass', {
    read: true,
    search: true,
    guardedPatch: true,
    exitCodes: [0, 7],
    signedDeny: true,
    busyDeferred: true,
    pendingInterruptRefused: true,
    activeInterrupt: true,
    childExited: true,
  });
}
