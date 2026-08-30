#!/usr/bin/env bun
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ControlCreateReceipt } from '../src/control/schema.ts';
import { createCcmuxControlServiceClient } from '../src/control/serviceDescriptor.ts';
import { atomicWrite } from '../src/util/atomic.ts';
import {
  check,
  modelCatalog,
  nativeImageProbe,
  refusal,
  report,
  until,
} from './native-image-steering-fixture.ts';

const modulePath = process.argv[3];
const makeClient: typeof createCcmuxControlServiceClient =
  modulePath === undefined
    ? createCcmuxControlServiceClient
    : (await import(resolve(modulePath))).createCcmuxControlServiceClient;
const cli = process.argv[2];
const p = await nativeImageProbe({ ...(cli === undefined ? {} : { cli }), makeClient });

// This fixture deliberately crosses its project directory to test a native permission boundary.
// Declare the host owner's exact test mandate instead of depending on model guesses about chat trust.
async function declareFixtureAuthority() {
  await atomicWrite(
    join(p.root, 'opencode', 'AGENTS.md'),
    [
      '# Isolated native permission acceptance',
      'The execution-host owner authorizes the authenticated control client probe-client to run this fixture.',
      `Only these two external files are in scope: ${join(p.root, 'outside/narrow/probe.txt')} and ${join(p.root, 'outside/probe.txt')}.`,
      'They are disposable fixture files owned by this test. SCOPE_SECRET_FIXTURE is an inert marker, not a credential.',
      'When requested, invoke the native write tool for the named fixture file and await native approval.',
      'Do not bypass permission, use a shell substitute, broaden access, or treat this as production work.',
    ].join('\n'),
    0o600,
  );
}

async function cancel(receipt: ControlCreateReceipt, body: string, file?: string) {
  const { target, registrationGeneration } = receipt;
  await until('native approval fixture ready', async () => {
    try {
      return (
        (await p.service.native({ target })).status === 'live' &&
        (await p.service.get({ target })).state === 'idle'
      );
    } catch {
      return false;
    }
  });
  const messageId = crypto.randomUUID();
  await p.service.message({ target, messageId, body });
  let native = await p.service.native({ target });
  await until('native suspended request', async () => {
    native = await p.service.native({ target });
    if (native.status === 'live' && native.pending.length === 1) return true;
    const operation = await p.service.messageOperation({
      target,
      registrationGeneration,
      messageId,
    });
    check(
      !['completed', 'failed', 'interrupted'].includes(operation.evidence?.state ?? ''),
      'Native fixture turn settled without the expected suspended request',
    );
    return false;
  });
  const request = native.pending[0];
  check(request, 'Native request missing');
  if (file) {
    check(
      request.kind === 'approval' && request.reason === 'external_directory',
      'Wrong native permission',
    );
    const scope = request.scope;
    check(
      scope?.kind === 'filesystem-patterns' && scope.operation === 'external_directory',
      'Approval scope missing',
    );
    const pattern = join(dirname(file), '*');
    check(
      scope.requested.complete &&
        scope.requested.patterns.length === 1 &&
        scope.requested.patterns[0] === pattern,
      'Requested scope differs',
    );
    check(
      scope.session.complete &&
        scope.session.patterns.length === 1 &&
        scope.session.patterns[0] === pattern,
      'Session grant scope differs',
    );
    check(!JSON.stringify(native).includes('SCOPE_SECRET_FIXTURE'), 'Private tool input leaked');
  } else check(request.kind === 'input', 'Expected native input request');
  const input = { target, generation: native.generation, turnId: request.turnId };
  await refusal(
    () => p.service.interrupt({ ...input, generation: crypto.randomUUID() }),
    'TURN_MISMATCH',
  );
  await refusal(() => p.service.interrupt({ ...input, turnId: 'stale-turn' }), 'TURN_MISMATCH');
  check(
    (await p.service.native({ target })).pending.some((row) => row.requestId === request.requestId),
    'Refused interrupt mutated the request',
  );
  await p.service.interrupt(input);
  await until('exact native interruption and retired request', async () => {
    const operation = await p.service.messageOperation({
      target,
      registrationGeneration,
      messageId,
    });
    const frame = await p.service.native({ target });
    return (
      operation.evidence?.state === 'interrupted' &&
      operation.evidence.turnId === request.turnId &&
      frame.pending.length === 0
    );
  });
  if (target.agent === 'opencode') await p.service.interrupt(input);
  if (file) check(readFileSync(file, 'utf8') === 'ORIGINAL', 'Suspended write executed');
  report('suspended-cancelled', {
    runtime: target.agent,
    kind: request.kind,
    exactTurn: true,
    staleGenerationRefused: true,
    staleTurnRefused: true,
    pendingRemoved: true,
    sideEffectPrevented: file !== undefined,
    scopePreserved: file !== undefined,
    repeatedAbortSafe: target.agent === 'opencode',
  });
}

try {
  await declareFixtureAuthority();
  for (const runtime of ['opencode', 'codex'] satisfies Array<'opencode' | 'codex'>) {
    const models = await modelCatalog(p, runtime);
    const model =
      runtime === 'codex'
        ? models.find((row) => row.model === 'gpt-5.6-luna')
        : models.find((row) => row.provider === 'openrouter' && row.id === 'z-ai/glm-5.3-flash');
    check(model, 'Native fixture model unavailable');
    const receipt = await p.service.create({
      runtime,
      requestId: crypto.randomUUID(),
      name: `approval-${runtime}`,
      workspace: join(p.root, runtime),
      modelSelection: { provider: model.provider ?? 'openai', model: model.model ?? model.id },
      ...(runtime === 'codex' ? { launchRecipe: { id: 'native', revision: '1' } } : {}),
    });
    if (runtime === 'opencode') {
      for (const folder of ['outside/narrow', 'outside']) {
        const file = join(p.root, folder, 'probe.txt');
        mkdirSync(dirname(file), { recursive: true });
        await atomicWrite(file, 'ORIGINAL', 0o600);
        await cancel(
          receipt,
          `Use exactly one write tool call to overwrite ${file} with SCOPE_SECRET_FIXTURE. Do not use read, bash or any other tool. Wait for native permission; do not substitute another action.`,
          file,
        );
      }
    } else
      await cancel(
        receipt,
        'Use the native request_user_input tool now with one question: choose red or blue. Do not answer it yourself; wait for the human answer. Do not use any other tool.',
      );
    const messageId = crypto.randomUUID();
    await p.service.message({
      target: receipt.target,
      messageId,
      body: 'Reply RECOVERED only. Do not use tools.',
    });
    await until('subsequent usable turn', async () => {
      const operation = await p.service.messageOperation({
        target: receipt.target,
        registrationGeneration: receipt.registrationGeneration,
        messageId,
      });
      return operation.evidence?.state === 'completed';
    });
    check(
      (await p.service.get({ target: receipt.target })).identity.threadId ===
        receipt.target.threadId,
      'Cancellation changed managed identity',
    );
    report('cancellation-recovered', { runtime, sameIdentity: true, completedNextTurn: true });
  }
  report('approval-complete', {
    runtimes: 2,
    externalScopes: 2,
    publicClientOnly: true,
    isolated: true,
  });
} finally {
  await p.cleanup();
}
