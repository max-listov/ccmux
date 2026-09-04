#!/usr/bin/env bun
import { join, resolve } from 'node:path';
import type { ControlCreateReceipt } from '../src/control/schema.ts';
import { createInjectedControlClient } from '../src/control/transportBoundary.ts';
import { killSession } from '../src/tmux/tmux.ts';
import {
  check,
  modelCatalog,
  nativeImageProbe,
  report,
  until,
} from './native-image-steering-fixture.ts';

const modulePath = process.argv[3];
const makeClient: typeof createInjectedControlClient =
  modulePath === undefined
    ? createInjectedControlClient
    : (await import(resolve(modulePath))).createInjectedControlClient;
const cli = process.argv[2];
const p = await nativeImageProbe({ ...(cli === undefined ? {} : { cli }), makeClient });
type Client = ReturnType<typeof createInjectedControlClient>;
type Selector = Parameters<Client['message.operation']>[0];
const body = 'Reply CORRELATION_OK only. Do not use tools, send messages, or ask questions.';

async function terminal(client: Client, selector: Selector) {
  await until('exact message terminal', async () => {
    const result = await client['message.operation'](selector);
    const state = result.evidence?.state;
    check(state !== 'failed' && state !== 'interrupted', 'Native correlation turn failed');
    return state === 'completed';
  });
  const result = await client['message.operation'](selector);
  check(result.evidence?.turnId, 'Native receipt omitted exact turn');
  const frame = await client['native.read']({ target: selector.target });
  check(
    [...frame.baseline, ...frame.records].some(
      (record) =>
        record.kind === 'terminal' &&
        record.status === 'completed' &&
        record.turnId === result.evidence?.turnId,
    ),
    'Public native content has no matching terminal',
  );
  return result;
}

async function prove(receipt: ControlCreateReceipt) {
  const { target, registrationGeneration } = receipt;
  await until('ready for correlation', async () => {
    try {
      return (await p.service['session.get']({ target })).state === 'idle';
    } catch {
      return false;
    }
  });
  const selector = (messageId: string): Selector => ({ target, registrationGeneration, messageId });
  const first = { target, messageId: crypto.randomUUID(), body };
  // Discard the first response to model a lost caller ACK, then retry the exact original request.
  await p.service['message.send'](first);
  check(
    (await p.service['message.send'](first)).duplicate,
    'Lost caller ACK retry was not idempotent',
  );
  await terminal(p.service, selector(first.messageId));
  const second = {
    target,
    messageId: crypto.randomUUID(),
    body,
    defer: true,
    notBefore: new Date(Date.now() + 30_000).toISOString(),
  };
  await p.service['message.send'](second);
  check(
    (await p.service['message.operation'](selector(second.messageId))).evidence?.state === 'queued',
    'Deferred message has premature native admission',
  );
  const external = p.client('other-client');
  const intervening = { ...first, messageId: crypto.randomUUID() };
  await external['message.send'](intervening);
  const outside = await terminal(external, selector(intervening.messageId));
  check(
    (await p.service['message.operation'](selector(intervening.messageId))).outcome ===
      'unavailable',
    'Other sender correlation leaked',
  );
  const queued = await p.service['message.operation'](selector(second.messageId));
  check(queued.evidence?.state === 'queued', 'Intervening turn did not precede deferred dispatch');
  // New client instance has no local ordering/text state.
  const reconnected = p.client('probe-client');
  const secondResult = await terminal(reconnected, selector(second.messageId));
  const firstResult = await reconnected['message.operation'](selector(first.messageId));
  check(
    new Set([firstResult.evidence?.turnId, secondResult.evidence?.turnId, outside.evidence?.turnId])
      .size === 3,
    'Native turns were conflated',
  );
  check((await reconnected['message.send'](second)).duplicate, 'Deferred retry duplicated');
  check(
    JSON.stringify(await reconnected['message.operation'](selector(second.messageId))) ===
      JSON.stringify(secondResult),
    'Retry changed terminal binding',
  );
  const history = await reconnected['history.read']({ target, registrationGeneration, limit: 64 });
  for (const result of [firstResult, secondResult, outside]) {
    check(
      history.entries.some((entry) => entry.turnId === result.evidence?.turnId),
      'Exact native history binding absent',
    );
  }
  report('correlation', {
    runtime: target.agent,
    first: firstResult,
    second: secondResult,
    interveningTurn: outside.evidence?.turnId,
    identicalText: true,
    deferred: true,
    reconnect: true,
    callerIsolated: true,
  });
  return { receipt, retained: [firstResult, secondResult] };
}

try {
  const receipts: ControlCreateReceipt[] = [];
  for (const runtime of ['codex', 'opencode'] satisfies Array<'codex' | 'opencode'>) {
    const models = await modelCatalog(p, runtime);
    const selected =
      runtime === 'codex'
        ? (models.find((model) => model.model === 'gpt-5.6-luna') ??
          models.find((model) => model.isDefault))
        : models.find(
            (model) => model.provider === 'openrouter' && model.id === 'z-ai/glm-5.3-flash',
          );
    check(selected, 'Configured native test model unavailable');
    receipts.push(
      await p.service['session.create']({
        runtime,
        requestId: crypto.randomUUID(),
        name: `correlation-${runtime}`,
        workspace: join(p.root, runtime),
        ...(runtime === 'codex' ? { launchRecipe: { id: 'native', revision: '1' } } : {}),
        modelSelection: {
          provider: selected.provider ?? 'openai',
          model: selected.model ?? selected.id,
        },
      }),
    );
  }
  const proofs = await Promise.all(receipts.map(prove));
  await p.restartDaemon();
  for (const proof of proofs) {
    for (const retained of proof.retained) {
      const { target, registrationGeneration, messageId } = retained;
      check(
        JSON.stringify(
          await p.service['message.operation']({ target, registrationGeneration, messageId }),
        ) === JSON.stringify(retained),
        'Daemon restart changed correlation',
      );
    }
    const { target, registrationGeneration } = proof.receipt;
    const before = await p.service['native.read']({ target });
    await killSession(p.machine, target.session);
    await p.service['session.start']({ target });
    await until(
      'provider restarted under same identity',
      async () => {
        try {
          const frame = await p.service['native.read']({ target });
          return (
            frame.status === 'live' &&
            frame.generation !== before.generation &&
            (await p.service['session.get']({ target })).state === 'idle'
          );
        } catch {
          return false;
        }
      },
      30_000,
    );
    for (const retained of proof.retained)
      check(
        JSON.stringify(
          await p.client('probe-client')['message.operation']({
            target,
            registrationGeneration,
            messageId: retained.messageId,
          }),
        ) === JSON.stringify(retained),
        'Provider restart changed correlation',
      );
    const resumed = { target, messageId: crypto.randomUUID(), body };
    await p.service['message.send'](resumed);
    const result = await terminal(p.service, {
      target,
      registrationGeneration,
      messageId: resumed.messageId,
    });
    report('correlation-restart-resume', {
      runtime: target.agent,
      daemonRestart: true,
      providerRestart: true,
      retainedBindings: proof.retained.length,
      resumed: result,
    });
  }
  report('correlation-complete', { runtimes: 2, publicClientOnly: true, isolated: true });
} finally {
  await p.cleanup();
}
