#!/usr/bin/env bun
import { join, resolve } from 'node:path';
import type { ContentRecord } from '../src/content/schema.ts';
import type { ControlCreateReceipt } from '../src/control/schema.ts';
import { createCcmuxControlServiceClient } from '../src/control/serviceDescriptor.ts';
import { killSession } from '../src/tmux/tmux.ts';
import {
  check,
  modelCatalog,
  nativeImageProbe,
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

async function ready(receipt: ControlCreateReceipt, previousGeneration?: string) {
  await until('native tool fixture ready', async () => {
    try {
      const native = await p.service.native({ target: receipt.target });
      return (
        native.status === 'live' &&
        native.generation !== previousGeneration &&
        (await p.service.get({ target: receipt.target })).state === 'idle'
      );
    } catch {
      return false;
    }
  });
}
async function prove(receipt: ControlCreateReceipt) {
  const { target, registrationGeneration } = receipt;
  await ready(receipt);
  let cursor = await p.service.native({ target });
  const records = new Map<string, ContentRecord>();
  const answered = new Set<string>();
  const messageId = crypto.randomUUID();
  await p.service.message({
    target,
    messageId,
    body: "Run exactly two separate shell tool calls, sequentially: first `printf 'TOOL_OK\\n'`, then `sh -c 'exit 7'`. Do not combine them into one tool call. The nonzero exit is deliberate: do not retry, repair, or suppress it. Use no other tools. After both tool calls finish, reply TOOL_PROBE_DONE.",
    ...(receipt.modelSelection && target.agent === 'codex'
      ? { options: { runtime: 'codex', model: receipt.modelSelection, mode: 'default' } }
      : {}),
  });
  await until('two native shell outcomes', async () => {
    const frame = await p.service.native({
      target,
      cursor: { generation: cursor.generation, sequence: cursor.sequence },
    });
    check(frame.status === 'live', 'Native tool observer lost its lease');
    cursor = frame;
    for (const record of [...frame.baseline, ...frame.records])
      if (record.kind === 'tool')
        records.set(JSON.stringify([record.turnId, record.itemId]), record);
    for (const request of frame.pending) {
      check(
        request.kind === 'approval' && request.decisions.includes('accept'),
        'Unexpected native fixture request',
      );
      if (answered.has(request.requestId)) continue;
      await p.service.respond({
        target,
        generation: frame.generation,
        operationId: crypto.randomUUID(),
        requestId: request.requestId,
        kind: 'approval',
        decision: 'accept',
      });
      answered.add(request.requestId);
    }
    const operation = await p.service.messageOperation({
      target,
      registrationGeneration,
      messageId,
    });
    check(
      operation.evidence?.state !== 'failed' && operation.evidence?.state !== 'interrupted',
      'Native tool fixture turn failed',
    );
    return operation.evidence?.state === 'completed';
  });
  const operation = await p.service.messageOperation({ target, registrationGeneration, messageId });
  const turnId = operation.evidence?.turnId;
  check(turnId, 'Fixture message has no exact native turn');
  const tools = [...records.values()].filter((record) => record.turnId === turnId);
  report('tool-observed', { runtime: target.agent, tools });
  check(tools.length === 2, 'Fixture did not execute exactly two tools');
  const name = target.agent === 'codex' ? 'commandExecution' : 'bash';
  check(
    tools.every(
      (record) =>
        record.tool?.callId &&
        record.tool.name === name &&
        record.tool.lifecycle === 'completed' &&
        record.complete,
    ),
    'Tool identity/name/lifecycle lost',
  );
  check(
    tools.some((record) => record.tool?.exitCode === 0 && record.tool.outcome === 'succeeded'),
    'Successful native tool outcome missing',
  );
  check(
    tools.some((record) => record.tool?.exitCode === 7 && record.tool.outcome === 'failed'),
    'Failing native tool outcome missing',
  );
  const reconnect = p.client('probe-client');
  const frame = await reconnect.native({ target });
  const history = await reconnect.history({ target, registrationGeneration, limit: 64 });
  for (const tool of tools) {
    const match = (entry: { turnId: string | null; itemId: string }) =>
      entry.turnId === tool.turnId && entry.itemId === tool.itemId;
    check(
      JSON.stringify(frame.baseline.find(match)?.tool) === JSON.stringify(tool.tool),
      'Reconnect changed tool evidence',
    );
    check(
      JSON.stringify(history.entries.find(match)?.tool) === JSON.stringify(tool.tool),
      'History differs from live native tool evidence',
    );
  }
  report('tool-outcomes', {
    runtime: target.agent,
    successfulExit: 0,
    failingExit: 7,
    turnCompleted: true,
    approvals: answered.size,
    reconnect: true,
    exactLiveHistoryMatch: true,
  });
  return { receipt, tools };
}

try {
  const receipts: ControlCreateReceipt[] = [];
  for (const runtime of ['codex', 'opencode'] satisfies Array<'codex' | 'opencode'>) {
    const models = await modelCatalog(p, runtime);
    const selected =
      runtime === 'codex'
        ? models.find((model) => model.model === 'gpt-5.6-luna')
        : models.find(
            (model) => model.provider === 'openrouter' && model.id === 'z-ai/glm-5.3-flash',
          );
    check(selected, 'Configured native tool fixture model unavailable');
    receipts.push(
      await p.service.create({
        runtime,
        requestId: crypto.randomUUID(),
        name: `tool-${runtime}`,
        workspace: join(p.root, runtime),
        modelSelection: {
          provider: selected.provider ?? 'openai',
          model: selected.model ?? selected.id,
        },
        ...(runtime === 'codex' ? { launchRecipe: { id: 'native', revision: '1' } } : {}),
      }),
    );
  }
  const proofs = await Promise.all(receipts.map(prove));
  await p.restartDaemon();
  for (const { receipt, tools } of proofs) {
    const { target, registrationGeneration } = receipt;
    const before = await p.service.native({ target });
    for (const tool of tools)
      check(
        JSON.stringify(
          before.baseline.find(
            (entry) => entry.turnId === tool.turnId && entry.itemId === tool.itemId,
          )?.tool,
        ) === JSON.stringify(tool.tool),
        'Daemon restart changed tool observation',
      );
    await killSession(p.machine, target.session);
    await p.service.start({ target });
    await ready(receipt, before.generation);
    const history = await p
      .client('probe-client')
      .history({ target, registrationGeneration, limit: 64 });
    for (const tool of tools)
      check(
        JSON.stringify(
          history.entries.find(
            (entry) => entry.turnId === tool.turnId && entry.itemId === tool.itemId,
          )?.tool,
        ) === JSON.stringify(tool.tool),
        'Provider resume changed native tool identity/outcome',
      );
    report('tool-resume', {
      runtime: target.agent,
      daemonRestart: true,
      providerRestart: true,
      retainedToolEvidence: tools.length,
    });
  }
  report('tool-complete', { runtimes: 2, publicClientOnly: true, isolated: true });
} finally {
  await p.cleanup();
}
