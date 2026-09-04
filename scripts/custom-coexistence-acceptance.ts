import { samePrincipal, sameTarget } from '../src/chat/identity.ts';
import { loadLedger } from '../src/chat/store.ts';
import type { ControlCreateReceipt } from '../src/control/schema.ts';
import { shellJoin } from '../src/util/shellQuote.ts';
import { check, type NativeImageProbe, report, until } from './native-image-steering-fixture.ts';

/** Exactly three real provider owners communicate through the existing authenticated chat ledger. */
export async function customCoexistence(p: NativeImageProbe, custom: ControlCreateReceipt) {
  const codexModels = await p.service['model.list']({ runtime: 'codex' });
  const model =
    codexModels.data.find((row) => row.id === 'gpt-5.6-luna') ??
    codexModels.data.find((row) => row.isDefault);
  check(model, 'Native Codex catalog has no default');
  const codex = await p.service['session.create']({
    requestId: crypto.randomUUID(),
    runtime: 'codex',
    name: 'codex-peer',
    workspace: `${p.root}/codex`,
    flags: [],
    launchRecipe: { id: 'native', revision: '1' },
    modelSelection: { provider: 'openai', model: model.model ?? model.id },
  });
  const opencode = await p.service['session.create']({
    requestId: crypto.randomUUID(),
    runtime: 'opencode',
    name: 'opencode-peer',
    workspace: `${p.root}/opencode`,
    flags: [],
    modelSelection: custom.modelSelection,
  });
  const all = [codex, opencode, custom];
  check(new Set(all.map((row) => row.target.threadId)).size === 3, 'Three registrations collided');
  await until('three native owners ready', async () => {
    const rows = await Promise.all(
      all.map((row) =>
        p.service['session.get']({ target: row.target }).catch((error) => {
          if (error instanceof Error && 'code' in error && error.code === 'UNAVAILABLE')
            return null;
          throw error;
        }),
      ),
    );
    return rows.every((row) => row?.availability === 'live' && row.state === 'idle');
  });
  const token = `route-${crypto.randomUUID()}`;
  const currentModel = (await p.service['native.read']({ target: custom.target })).nativeProfile
    ?.model;
  if (currentModel) {
    const selection = await p.service['selection.read']({
      target: custom.target,
      registrationGeneration: custom.registrationGeneration,
    });
    await p.service['selection.update']({
      target: custom.target,
      registrationGeneration: custom.registrationGeneration,
      operationId: crypto.randomUUID(),
      expectedRevision: selection.current.revision,
      options: { runtime: 'custom', model: currentModel },
    });
  }
  const args = (target: ControlCreateReceipt['target'], body: string) => [
    '--no-env-file',
    p.cli,
    'msg',
    `${target.machine}:${target.session}`,
    '--to-agent',
    target.agent,
    '--to-thread',
    target.threadId,
    body,
  ];
  const command = (target: ControlCreateReceipt['target'], body: string) =>
    shellJoin([process.execPath, ...args(target, body)]);
  const final = { executable: 'runner', args: args(codex.target, `${token}:C_TO_A`) };
  const second = command(custom.target, `${token}:B_TO_C`);
  for (const [receipt, body] of [
    [
      custom,
      `Remember this isolated routing instruction for the next incoming message ${token}:B_TO_C. At that time call run_command once with this EXACT JSON input (no shell, no quoting changes):\n${JSON.stringify(final)}\nThen finish SENT. Do not execute anything now. Reply READY now without tools.`,
    ],
    [
      opencode,
      `Remember this isolated routing instruction: when a NEW incoming message contains ${token}:A_TO_B, execute this shell command once:\n${second}\nThen finish SENT without sending any extra message. Do not execute it yet. Reply READY now without tools.`,
    ],
  ] satisfies [ControlCreateReceipt, string][]) {
    const messageId = crypto.randomUUID();
    await p.service['message.send']({ target: receipt.target, messageId, body });
    await until('routing instruction retained', async () => {
      const result = await p.service['message.operation']({
        target: receipt.target,
        registrationGeneration: receipt.registrationGeneration,
        messageId,
      });
      check(result.evidence?.state !== 'failed', 'Routing preparation failed');
      return result.evidence?.state === 'completed';
    });
  }
  const first = command(opencode.target, `${token}:A_TO_B`);
  await p.service['message.send']({
    target: codex.target,
    messageId: crypto.randomUUID(),
    body: `Authorized isolated communication test. Run exactly this command:\n${first}\nThen finish SENT immediately. Do not poll or wait; the reply arrives asynchronously. On ${token}:C_TO_A, reply RECEIVED without tools.`,
  });
  let edges = 0;
  await until(
    'exact three-runtime route',
    async () => {
      for (const { target } of all) {
        const frame = await p.service['native.read']({ target }).catch((error) => {
          if (error instanceof Error && 'code' in error && error.code === 'UNAVAILABLE')
            return null;
          throw error;
        });
        const pending = frame?.pending[0];
        if (frame && pending?.kind === 'approval')
          await p.service['native.respond']({
            target,
            operationId: crypto.randomUUID(),
            generation: frame.generation,
            requestId: pending.requestId,
            kind: 'approval',
            decision: 'accept',
          });
      }
      const ledger = loadLedger(p.machine).filter((row) => row?.body.includes(token));
      edges = [
        [codex.target, opencode.target],
        [opencode.target, custom.target],
        [custom.target, codex.target],
      ].filter(
        ([from, to]) =>
          from &&
          to &&
          ledger.some((row) => row && samePrincipal(row.from, from) && sameTarget(row.to, to)),
      ).length;
      return edges === 3;
    },
    180_000,
  );
  await until(
    'three-runtime terminal pickup',
    async () => {
      const outcomes = await Promise.all(
        all.map(({ target }) => p.service['session.wait']({ target, timeoutMs: 500 })),
      );
      check(!outcomes.some((row) => row.outcome === 'failed'), 'Cross-runtime pickup failed');
      return outcomes.every((row) => row.outcome === 'completed');
    },
    60_000,
  );
  report('three-runtime-coexistence', {
    targets: all.map((row) => row.target),
    edges,
    exactProviderMachineSession: true,
  });
}
