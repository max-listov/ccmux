import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MachineLaunchRecipeSchema } from '../src/config/schema.ts';
import { killSession } from '../src/tmux/tmux.ts';
import { atomicWrite } from '../src/util/atomic.ts';
import { customCoding } from './custom-coding-acceptance.ts';
import { customCoexistence } from './custom-coexistence-acceptance.ts';
import { customResident } from './custom-resident-acceptance.ts';
import {
  check,
  geometryImage,
  nativeImageProbe,
  refusal,
  report,
  until,
  uploadImage,
} from './native-image-steering-fixture.ts';

const cli = process.argv[2],
  authPath = process.argv[3],
  model = process.argv[4];
const visionModel = process.argv[5]?.startsWith('--') ? undefined : process.argv[5];
if (!cli || !authPath || !model)
  throw new Error('Pass the actual built CLI, existing host auth file and exact model ID');
const auth = z
  .object({ openrouter: z.object({ type: z.literal('api'), key: z.string().min(1) }) })
  .parse(JSON.parse(await readFile(authPath, 'utf8')));
const approvalSecret = crypto.randomUUID() + crypto.randomUUID();
const p = await nativeImageProbe({
  cli,
  configure: async (root, machine) => {
    machine.launchRecipes.native = MachineLaunchRecipeSchema.parse({
      revision: '1',
      flags: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'],
    });
    await mkdir(join(root, 'custom'));
    const envFile = join(root, 'private.env');
    await atomicWrite(
      envFile,
      `MODEL_SERVICE_TOKEN='${auth.openrouter.key}'\nTOOL_APPROVAL_KEY='${approvalSecret}'\n`,
      0o600,
    );
    machine.launchRecipes.custom = MachineLaunchRecipeSchema.parse({
      revision: 'one',
      envFile,
      capabilities: ['external-provider'],
      custom: {
        provider: { kind: 'openrouter', credentialEnv: 'MODEL_SERVICE_TOKEN' },
        models: [
          {
            selection: { provider: 'openrouter', model },
            contextWindow: 32768,
            capabilities: ['tools'],
          },
          ...(visionModel
            ? [
                {
                  selection: { provider: 'openrouter', model: visionModel },
                  contextWindow: 32768,
                  capabilities: ['vision', 'tools'],
                },
              ]
            : []),
        ],
        defaultModel: { provider: 'openrouter', model },
        trustedRoots: [],
        resources: [],
        tools: [
          'read_file',
          'write_file',
          'search_files',
          'edit_file',
          'run_command',
          'read_output',
        ],
        approvalTools: ['write_file', 'edit_file', 'run_command'],
        approvalSecretEnv: 'TOOL_APPROVAL_KEY',
        executables: { shell: '/bin/sh', runner: process.execPath },
        commandEnvironment: [],
      },
    });
  },
});
report('custom-fixture', { root: p.root });
try {
  const catalog = await p.service['model.list']({
    runtime: 'custom',
    launchRecipe: { id: 'custom', revision: 'one' },
  });
  check(
    catalog.data.some((row) => row.id === model),
    'Host registry did not expose the exact model before create',
  );
  const create = {
    requestId: crypto.randomUUID(),
    runtime: 'custom',
    name: 'custom-agent',
    workspace: join(p.root, 'custom'),
    launchRecipe: { id: 'custom', revision: 'one' },
    flags: [],
  } satisfies Parameters<(typeof p.service)['session.create']>[0];
  const receipt = await p.service['session.create'](create);
  check((await p.service['session.create'](create)).duplicate, 'Create retry did not reconcile');
  const target = receipt.target;
  await until('Custom ready', async () => {
    try {
      return (await p.service['session.get']({ target })).state === 'idle';
    } catch {
      return false;
    }
  });
  report('custom-created', { receipt });
  const message = {
    target,
    messageId: crypto.randomUUID(),
    body: 'Use write_file to create proof.txt with the exact content PROOF_ONCE, overwrite false. Then respond DONE. Do not run commands or send any messages.',
  };
  await p.service['message.send'](message);
  check((await p.service['message.send'](message)).duplicate, 'Message retry duplicated');
  await until('Custom real signed approval', async () => {
    const frame = await p.service['native.read']({ target }).catch((error) => {
      if (error instanceof Error && 'code' in error && error.code === 'UNAVAILABLE') return null;
      throw error;
    });
    const status = await p.service['message.operation']({
      target,
      registrationGeneration: receipt.registrationGeneration,
      messageId: message.messageId,
    });
    check(status.evidence?.state !== 'failed', 'Real provider turn failed');
    return (frame?.pending.length ?? 0) > 0;
  });
  check(!(await Bun.file(join(p.root, 'custom/proof.txt')).exists()), 'Tool ran before approval');
  const before = await p.service['native.read']({ target });
  await killSession(p.machine, target.session);
  await p.service['session.start']({ target });
  await until('Custom approval after restart', async () => {
    try {
      const frame = await p.service['native.read']({ target });
      return frame.generation !== before.generation && frame.pending.length > 0;
    } catch {
      return false;
    }
  });
  const frame = await p.service['native.read']({ target });
  check(
    frame.nativeProfile?.model.model === model,
    'Native applied model proof is absent after restart',
  );
  const request = frame.pending[0];
  check(request, 'Pending approval disappeared');
  await refusal(
    () =>
      p.service['native.respond']({
        target,
        operationId: crypto.randomUUID(),
        generation: before.generation,
        requestId: request.requestId,
        kind: 'approval',
        decision: 'accept',
      }),
    'STALE_REQUEST',
  );
  const answer = {
    target,
    operationId: crypto.randomUUID(),
    generation: frame.generation,
    requestId: request.requestId,
    kind: 'approval',
    decision: 'accept',
  } satisfies Parameters<(typeof p.service)['native.respond']>[0];
  await p.service['native.respond'](answer);
  await refusal(
    () => p.service['native.respond']({ ...answer, decision: 'decline' }),
    'IDEMPOTENCY_CONFLICT',
  );
  await until('Custom approval continuation terminal', async () => {
    const result = await p.service['message.operation']({
      target,
      registrationGeneration: receipt.registrationGeneration,
      messageId: message.messageId,
    });
    check(result.evidence?.state !== 'failed', 'Custom successor failed');
    return result.evidence?.state === 'completed';
  });
  const correlated = await p.service['message.operation']({
    target,
    registrationGeneration: receipt.registrationGeneration,
    messageId: message.messageId,
  });
  check(correlated.evidence?.turnId === message.messageId, 'Original run binding changed');
  check(correlated.evidence.continuations.length === 1, 'Exact successor not recorded');
  check(
    (await readFile(join(p.root, 'custom/proof.txt'), 'utf8')) === 'PROOF_ONCE',
    'Real file effect differs',
  );
  await p.service['native.respond'](answer);
  await p.restartDaemon();
  check(
    (await p.service['session.create'](create)).duplicate,
    'Daemon restart changed registration',
  );
  const native = await p.service['native.read']({ target });
  const history = await p.service['history.read']({
    target,
    registrationGeneration: receipt.registrationGeneration,
    limit: 32,
  });
  check(
    history.entries.some((entry) => entry.kind === 'user' && entry.turnId === message.messageId),
    'Canonical history lost user admission',
  );
  if (visionModel) {
    const reference = await uploadImage(p, target, geometryImage('png'), 'image/png');
    const imageMessage = {
      target,
      messageId: crypto.randomUUID(),
      images: [reference],
      body: 'Inspect the attached image. State the color and shape of the left object and then of the right object, in English. No tools.',
      options: { runtime: 'custom', model: { provider: 'openrouter', model: visionModel } },
    } satisfies Parameters<(typeof p.service)['message.send']>[0];
    await p.service['message.send'](imageMessage);
    check((await p.service['message.send'](imageMessage)).duplicate, 'Image retry duplicated');
    await until('real Custom vision terminal', async () => {
      const result = await p.service['message.operation']({
        target,
        registrationGeneration: receipt.registrationGeneration,
        messageId: imageMessage.messageId,
      });
      check(result.evidence?.state !== 'failed', 'Vision provider failed');
      return result.evidence?.state === 'completed';
    });
    const after = await p.service['history.read']({
      target,
      registrationGeneration: receipt.registrationGeneration,
      limit: 32,
    });
    const text = after.entries
      .filter((entry) => entry.turnId === imageMessage.messageId && entry.kind === 'assistant')
      .map((entry) => entry.text)
      .join('');
    check(/red\s+circle/i.test(text) && /blue\s+square/i.test(text), 'Real image semantics differ');
    check(
      after.entries.some((entry) =>
        entry.images.some((image) => image.digest === reference.digest),
      ),
      'Canonical history lost image',
    );
    const observed = await p.service['native.read']({ target });
    check(observed.nativeProfile?.model.model === visionModel, 'Actual vision model proof differs');
    report('custom-vision-pass', { model: visionModel, image: reference.digest, text });
  }
  const outward = JSON.stringify([receipt, correlated, native, catalog]);
  check(
    !outward.includes(auth.openrouter.key) && !outward.includes(approvalSecret),
    'Secret reached public metadata',
  );
  const log = await readFile(join(p.machine.stateDir, 'ccmux.log'), 'utf8');
  check(
    !log.includes(auth.openrouter.key) && !log.includes(approvalSecret),
    'Secret reached service log',
  );
  report('custom-managed-pass', {
    recipe: receipt.launchRecipe,
    model: receipt.modelSelection,
    correlated,
    oneWriter: true,
    realProvider: true,
    realFile: true,
    restarted: true,
  });
  if (process.argv.includes('--coexistence')) await customCoexistence(p, receipt);
  if (process.argv.includes('--coding')) await customCoding(p, receipt);
  if (process.argv.includes('--resident')) await customResident(p, receipt);
} finally {
  await p.cleanup();
}
