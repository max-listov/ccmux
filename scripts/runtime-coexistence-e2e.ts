import { join } from 'node:path';
import { samePrincipal, sameTarget } from '../src/chat/identity.ts';
import { loadLedger } from '../src/chat/ledger.ts';
import type { ControlNativeSnapshot } from '../src/control/schema/native.ts';
import type { createInjectedControlClient } from '../src/control/transport/boundary.ts';
import { loadSessions } from '../src/session/registry.ts';
import type { MachineConfig, ManagedPeer } from '../src/types.ts';
import { shellJoin } from '../src/util/shellQuote.ts';
import {
  acceptanceAuthorizationPath,
  readAcceptanceCommunicationAuthorization,
} from './acceptance-communication.ts';

type Client = ReturnType<typeof createInjectedControlClient>;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

type PickupClient = {
  [K in 'native.respond' | 'session.wait']: (
    ...args: Parameters<Client[K]>
  ) => ReturnType<Client[K]>;
} & {
  'native.read'(
    input: Parameters<Client['native.read']>[0],
  ): Promise<Pick<ControlNativeSnapshot, 'generation' | 'pending'>>;
};

/** A reply in the ledger is not terminal pickup; late native approvals still need an owner. */
export async function settleRuntimePeers(
  client: PickupClient,
  targets: readonly ManagedPeer[],
  deadline: number,
) {
  while (Date.now() < deadline) {
    for (const target of targets) {
      const frame = await client['native.read']({ target });
      const pending = frame.pending[0];
      if (pending?.kind === 'approval') {
        await client['native.respond']({
          target,
          operationId: crypto.randomUUID(),
          generation: frame.generation,
          requestId: pending.requestId,
          kind: 'approval',
          decision: 'accept',
        });
      }
    }
    const results = await Promise.all(
      targets.map((target) => client['session.wait']({ target, timeoutMs: 1_000 })),
    );
    if (results.every((result) => result.outcome === 'completed')) return;
    for (const result of results) {
      check(
        result.outcome === 'completed' || result.outcome === 'timeout',
        `Cross-runtime pickup ended with ${result.outcome}`,
      );
    }
  }
  throw new Error('Cross-runtime pickup timed out');
}

/**
 * Two real writers share only the control/chat plane, never native continuation or agent loop.
 * The caller chooses the second writer's runtime and model; the round trip is the same for any.
 */
export async function verifyRuntimeCoexistence(
  m: MachineConfig,
  client: Client,
  a: ManagedPeer,
  request: Parameters<Client['session.create']>[0],
) {
  const acceptanceCommunicationAuthorization = await readAcceptanceCommunicationAuthorization();
  const b = (await client['session.create'](request)).target;
  check(
    (await client['session.create'](request)).target.threadId === b.threadId,
    'Peer retry changed identity',
  );
  check(a.threadId !== b.threadId && a.session !== b.session, 'Writer identities collided');
  // Create answers with an identity; a native runtime publishes its projection after admission,
  // and the daemon observes the session only on its next pass — until then `session.get` has no
  // row to answer with, while the list simply does not show it live yet.
  const live = Date.now() + 20_000;
  while (
    !(await client['session.list']()).sessions.some(
      (row) => row.identity.threadId === b.threadId && row.availability === 'live',
    )
  ) {
    check(Date.now() < live, 'Peer never became live');
    await Bun.sleep(200);
  }
  const token = `runtime-${crypto.randomUUID()}`;
  const invocation = shellJoin([
    process.execPath,
    '--no-env-file',
    process.env.CCMUX_E2E_CLI ?? join(process.cwd(), 'src/cli.ts'),
  ]);
  await client['message.send']({
    communicationAuthorization: acceptanceCommunicationAuthorization,
    target: a,
    messageId: crypto.randomUUID(),
    body: `Authorized isolated communication test. Run exactly ${invocation} msg ${b.machine}:${b.session} --communication-authorization ${shellJoin([acceptanceAuthorizationPath()])} --to-agent ${b.agent} --to-thread ${b.threadId} with body "${token} A_TO_B. Reply once with ${token} B_TO_A using the pinned reply command from CCMux with --communication-authorization ${shellJoin([acceptanceAuthorizationPath()])}. Do not contact anyone else or edit files." After the command returns, finish this turn immediately with SENT. Do not poll, read logs or wait for a reply: CCMux delivers the reply asynchronously. When it arrives answer RECEIVED without using tools or sending another message.`,
  });
  const deadline = Date.now() + 180_000;
  let proved = false;
  while (!proved) {
    check(Date.now() < deadline, 'Cross-runtime round trip timed out');
    for (const target of [a, b]) {
      const frame = await client['native.read']({ target });
      const pending = frame.pending[0];
      if (pending?.kind === 'approval')
        await client['native.respond']({
          target,
          operationId: crypto.randomUUID(),
          generation: frame.generation,
          requestId: pending.requestId,
          kind: 'approval',
          decision: 'accept',
        });
    }
    const messages = loadLedger(m).filter((row) => row?.body.includes(token));
    proved =
      messages.some((row) => row && samePrincipal(row.from, a) && sameTarget(row.to, b)) &&
      messages.some((row) => row && samePrincipal(row.from, b) && sameTarget(row.to, a));
    await Bun.sleep(200);
  }
  await settleRuntimePeers(client, [a, b], deadline);
  console.log(
    JSON.stringify({
      phase: 'two-writer-round-trip',
      evidence: { identities: [a, b], exactProviderMachineSession: true },
    }),
  );
  const session = loadSessions(m).find((row) => row.uuid === b.threadId);
  check(session, 'Peer registration is missing');
  return session;
}
