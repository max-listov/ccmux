import type { createCcmuxControlServiceClient } from '../src/control/serviceDescriptor.ts';
import type { ManagedPeer } from '../src/types.ts';

type Client = ReturnType<typeof createCcmuxControlServiceClient>;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(label: string, probe: () => Promise<boolean>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    check(Date.now() < deadline, `Deadline: ${label}`);
    await Bun.sleep(150);
  }
}
async function approve(client: Client, target: ManagedPeer): Promise<void> {
  const frame = await client.native({ target });
  for (const request of frame.pending.filter((request) => request.kind === 'approval')) {
    const input = {
      target,
      operationId: crypto.randomUUID(),
      generation: frame.generation,
      requestId: request.requestId,
      kind: 'approval',
      decision: 'accept',
    } satisfies Parameters<Client['respond']>[0];
    await until(
      'exact native approval acknowledgement',
      async () => (await client.respond(input)).outcome === 'submitted',
      10_000,
    );
  }
}
async function settle(client: Client, target: ManagedPeer, outcome: string): Promise<void> {
  await until(`native ${outcome}`, async () => {
    await approve(client, target);
    const result = await client.wait({ target, timeoutMs: 1_000 });
    check(result.outcome !== 'failed', 'Native turn failed');
    return result.outcome === outcome;
  });
}

export async function verifyOpenCodeActions(client: Client, target: ManagedPeer): Promise<void> {
  await client.message({
    target,
    messageId: crypto.randomUUID(),
    body: 'Use the built-in question tool now. Ask me to choose Alpha or Beta, with exactly those two options. Do not use shell or edit files. After receiving my choice, reply INPUT_OK and that choice.',
  });
  let frame = await client.native({ target });
  await until('native question request', async () => {
    frame = await client.native({ target });
    return frame.pending.some((item) => item.kind === 'input');
  });
  const request = frame.pending.find((item) => item.kind === 'input');
  check(request && request.questions.length > 0, 'No native questions');
  const answers = Object.fromEntries(
    request.questions.map((question) => [question.id, [question.options?.[0]?.label ?? 'Alpha']]),
  );
  const response = {
    target,
    operationId: crypto.randomUUID(),
    generation: frame.generation,
    requestId: request.requestId,
    kind: 'input',
    answers,
  } satisfies Parameters<Client['respond']>[0];
  let staleRefused = false;
  try {
    await client.respond({ ...response, generation: crypto.randomUUID() });
  } catch (error) {
    staleRefused = error instanceof Error && 'code' in error && error.code === 'STALE_REQUEST';
  }
  check(staleRefused, 'Stale generation was accepted');
  check(
    (await client.native({ target })).pending.some((item) => item.requestId === request.requestId),
    'Stale response changed the request',
  );
  await until(
    'exact input acknowledgement',
    async () => (await client.respond(response)).outcome === 'submitted',
    10_000,
  );
  check(
    (await client.respond(response)).outcome === 'submitted',
    'Same operation response retry failed',
  );
  await settle(client, target, 'completed');
  console.log(
    JSON.stringify({
      phase: 'native-input',
      evidence: { exactRequest: true, staleGenerationRefused: true, responseRetry: true },
    }),
  );

  await client.message({
    target,
    messageId: crypto.randomUUID(),
    body: 'Use the shell tool to run sleep 8, then reply BUSY_DONE. Do not edit files or contact anyone.',
  });
  await until('working tool before defer', async () => {
    await approve(client, target);
    const state = await client.get({ target });
    return (
      state.state === 'working' &&
      (await client.native({ target })).baseline.some(
        (item) =>
          item.kind === 'tool' && item.turnId === state.turn?.id && item.status === 'running',
      )
    );
  });
  const busy = await client.get({ target });
  const deferredId = crypto.randomUUID();
  await client.message({
    target,
    messageId: deferredId,
    defer: true,
    body: 'Reply DEFERRED_OK only, without using tools.',
  });
  check(
    (await client.wait({ target, timeoutMs: 1_000 })).outcome === 'timeout',
    'Busy/deferred wait settled early',
  );
  check(
    (await client.get({ target })).turn?.id === busy.turn?.id,
    'Deferred input replaced active turn',
  );
  await settle(client, target, 'completed');
  console.log(
    JSON.stringify({
      phase: 'native-busy-defer',
      evidence: { workingTurnPreserved: true, earlyWaitRefused: true },
    }),
  );

  await client.message({
    target,
    messageId: crypto.randomUUID(),
    body: 'Use the shell tool to run sleep 30, then reply INTERRUPT_TEST_DONE. Do not edit files or contact anyone.',
  });
  await until('working tool before interrupt', async () => {
    await approve(client, target);
    const state = await client.get({ target });
    return (
      state.state === 'working' &&
      (await client.native({ target })).baseline.some(
        (item) =>
          item.kind === 'tool' && item.turnId === state.turn?.id && item.status === 'running',
      )
    );
  });
  const active = await client.get({ target });
  check(active.turn, 'No exact native turn');
  await client.interrupt({
    target,
    generation: (await client.native({ target })).generation,
    turnId: active.turn.id,
  });
  await settle(client, target, 'interrupted');
  await client.message({
    target,
    messageId: crypto.randomUUID(),
    body: 'Reply INTERRUPT_RECOVERED only. Do not use tools.',
  });
  await settle(client, target, 'completed');
  console.log(
    JSON.stringify({
      phase: 'native-interrupt-recovery',
      evidence: { interruptedNotCompleted: true, nextInputCompleted: true },
    }),
  );
}
