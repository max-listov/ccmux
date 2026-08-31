import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatChatInjection } from '../src/chat/format.ts';
import { loadCursors, loadLedger } from '../src/chat/store.ts';
import { loadMachineConfig } from '../src/config/machine.ts';
import type { ControlMessage } from '../src/control/schema.ts';
import {
  check,
  geometryImage,
  modelCatalog,
  nativeImageProbe,
  previewImage,
  refusal,
  report,
  until,
  uploadImage,
} from './native-image-steering-fixture.ts';

const telegram = process.argv.includes('--telegram') ? loadMachineConfig().telegram : undefined;
if (process.argv.includes('--telegram')) check(telegram, 'No existing owner notification sink');
const cli = process.argv[2];
const p = await nativeImageProbe({
  ...(cli && !cli.startsWith('--') ? { cli } : {}),
  configure: async (_root, machine) => {
    machine.telegram = telegram;
    machine.agentPolicies = {};
    machine.messageApplications = {
      'sample-app': {
        revision: 'r1',
        callers: ['probe-client'],
        channels: ['chat'],
        actors: ['human', 'agent'],
        ownerNotifications: true,
      },
    };
  },
});
try {
  const models = await modelCatalog(p, 'codex');
  const model =
    models.find((row) => row.id === 'gpt-5.6-luna' && row.inputModalities.includes('image')) ??
    models.find((row) => row.inputModalities.includes('image'));
  check(model, 'No native image model');
  const created = await p.service.create({
    requestId: crypto.randomUUID(),
    name: 'origin-probe',
    workspace: join(p.root, 'codex'),
    runtime: 'codex',
    flags: [],
    launchRecipe: { id: 'native', revision: '1' },
    modelSelection: { provider: 'openai', model: model.model ?? model.id },
  });
  await until('native idle positive baseline', async () => {
    try {
      return (await p.service.get({ target: created.target })).state === 'idle';
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'UNAVAILABLE') return false;
      throw error;
    }
  });
  if (telegram)
    await until(
      'mirror armed positive baseline',
      async () => loadCursors(p.machine).telegram !== null,
    );
  const bytes = geometryImage('png');
  const image = await uploadImage(p, created.target, bytes, 'image/png');
  const input: ControlMessage = {
    target: created.target,
    registrationGeneration: created.registrationGeneration,
    messageId: crypto.randomUUID(),
    images: [image],
    origin: { applicationId: 'sample-app', channelId: 'chat', actor: 'human' },
    body: "Describe the left object's color and shape, then the right object's color and shape, in English. Inspect the image, no tools or messages to other sessions.",
  };
  const origin = input.origin;
  check(origin, 'Missing attribution');
  await refusal(
    () => p.service.message({ ...input, origin: { ...origin, applicationId: 'forged' } }),
    'ORIGIN_REFUSED',
  );
  await refusal(
    () => p.service.message({ ...input, registrationGeneration: crypto.randomUUID() }),
    'IDENTITY_MISMATCH',
  );
  check(loadLedger(p.machine).length === 0, 'Refusal appended input');
  const receipt = await p.service.message(input);
  check(
    receipt.origin.ingress === 'service' &&
      receipt.origin.actor === 'human' &&
      receipt.origin.assurance === 'application-attested' &&
      receipt.notification === 'conversation',
    'Incorrect origin receipt',
  );
  check((await p.service.message(input)).duplicate, 'Retry duplicated input');
  await refusal(
    () => p.service.message({ ...input, notification: 'owner' }),
    'IDEMPOTENCY_CONFLICT',
  );
  // Accepted input and retained image must survive daemon replacement at any pickup phase.
  await p.restartDaemon();
  check((await p.service.message(input)).duplicate, 'Restart changed accepted identity');
  const selector = {
    target: created.target,
    registrationGeneration: created.registrationGeneration,
    messageId: input.messageId,
  };
  await until('exact correlated native completion', async () => {
    const result = await p.service.messageOperation(selector);
    check(result.evidence?.state !== 'failed', 'Native turn failed');
    return result.evidence?.state === 'completed';
  });
  const operation = await p.service.messageOperation(selector);
  check(operation.evidence?.turnId, 'No exact native turn');
  const history = await p.service.history({
    target: created.target,
    registrationGeneration: created.registrationGeneration,
    limit: 32,
  });
  const entries = history.entries.filter((row) => row.turnId === operation.evidence?.turnId);
  check(
    entries.some(
      (row) =>
        row.kind === 'user' &&
        row.text?.startsWith('[application input via ccmux/service') &&
        row.text.includes('not independently authenticated'),
    ),
    'Native provider did not receive honest application framing',
  );
  const answer = entries
    .filter((row) => row.kind === 'assistant')
    .map((row) => row.text)
    .join(' ');
  check(/red/i.test(answer) && /blue/i.test(answer), 'Image input was not consumed');
  check(
    entries.some(
      (row) => row.kind === 'user' && row.images.some((ref) => ref.digest === image.digest),
    ),
    'Native image missing',
  );
  await previewImage(p, created.target, image, bytes);
  const ledger = loadLedger(p.machine);
  check(ledger.length === 1 && ledger[0]?.id === input.messageId, 'Input replayed');
  const accepted = ledger[0];
  check(accepted, 'Missing durable input');
  check(
    formatChatInjection(accepted).startsWith('[application input via ccmux/service'),
    'False native framing',
  );
  const privateLog = () => readFileSync(join(p.machine.stateDir, 'ccmux.log'), 'utf8');
  if (telegram) {
    await until(
      'suppressed input observed',
      async () => loadCursors(p.machine).telegram === ledger.length,
    );
    check(
      privateLog().includes(`"messageId":"${input.messageId}","reason":"conversation-audience"`),
      'Missing suppression evidence',
    );
    check(!privateLog().includes('telegram mirror delivered'), 'Conversation echoed to Telegram');
    const courier = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        p.cli,
        'msg',
        'owner',
        'CCMux: проверка уведомлений пройдена. Ввод человека и межагентский чат больше не зеркалятся автоматически; это одно явное уведомление владельцу.',
      ],
      {
        env: p.env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: Bun.file(join(p.root, 'notice-error.log')),
      },
    );
    check((await courier.exited) === 0, 'Explicit owner CLI route failed');
    const notice = loadLedger(p.machine).at(-1);
    check(
      notice &&
        notice.to.kind === 'owner' &&
        notice.from.kind === 'cli' &&
        notice.notification === 'owner',
      'Explicit operator notice identity lost',
    );
    await until('explicit owner notice delivered', async () =>
      privateLog().includes(`"msg":"telegram mirror delivered","messageId":"${notice.id}"`),
    );
    report('telegram-live', {
      inputSuppressed: true,
      explicitNoticeDelivered: true,
      deliveredNotices: 1,
      exactlyOnceClaimed: false,
    });
  }
  report('native-origin', {
    realCodex: true,
    exactTurn: true,
    nonCliOrigin: true,
    imageConsumed: true,
    restartRetry: true,
    retainedPreview: true,
    acceptedMessages: 1,
    forgedOriginRefused: true,
    staleGenerationRefused: true,
    notificationEscalationConflict: true,
    telegramEnabled: Boolean(telegram),
  });
} finally {
  await p.cleanup();
}
