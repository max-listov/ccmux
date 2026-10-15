import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnedCodexProjection } from '../../src/agent/codex/owned/projection.ts';
import { OwnedCodexStatusWriter } from '../../src/agent/codex/owned/status.ts';
import { managedPeer, servicePrincipal } from '../../src/chat/identity.ts';
import { openApplicationAuthority } from '../../src/delegation/application.ts';
import { resolveDelegation } from '../../src/delegation/resolve.ts';
import { seedNativeSelection } from '../../src/runtime/selection.ts';
import { writeSessionsUnlocked } from '../../src/session/registry.ts';
import { communicationAuthorization } from '../communication-fixture.ts';
import { makeMachine, makeSession } from '../helpers.ts';

export const cleanup: (() => Promise<void>)[] = [];
export const signal = () => new AbortController().signal;
export function fixture(leaseMs = 60_000) {
  const root = realpathSync(mkdtempSync('/tmp/ccmux-application-test-'));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const binding = {
    applicationId: 'native-agent',
    channelId: 'native-run',
    actor: 'agent' as const,
    revision: '1',
  };
  const policy = {
    access: 'read-only' as const,
    readScope: 'host' as const,
    workspace: root,
    network: false as const,
  };
  const m = makeMachine({
    stateDir: join(root, 'state'),
    rcPrefix: 'host-a',
    chatEnabled: true,
    messageApplications: {
      'native-agent': {
        revision: '1',
        callers: ['host-a'],
        channels: ['native-run'],
        actors: ['agent'],
        ownerNotifications: false,
      },
    },
    applicationDelegationAuthorities: [{ binding, policy, leaseMs, lifetimeMs: 300_000 }],
  });
  const principal = servicePrincipal(m.rcPrefix, 'local');
  const input = {
    operationId: crypto.randomUUID(),
    binding,
    conversationId: 'native-conversation',
    runId: 'active-run',
    sourceMessageRef: communicationAuthorization.sourceMessageRef,
    authorizationQuote: communicationAuthorization.userAuthorizationQuote,
  };
  return { root, m, binding, policy, principal, input };
}

export async function ownedFixture(leaseMs?: number) {
  const f = fixture(leaseMs),
    authority = await openApplicationAuthority(f.m, f.principal, f.input);
  const delegation = resolveDelegation(
    f.m,
    'codex',
    'app-server',
    f.root,
    crypto.randomUUID(),
    { parent: authority.parent, policy: f.policy },
    f.principal,
  );
  const s = makeSession({
    name: 'owned-child',
    modelSelection: { provider: 'openai', model: 'test-model' },
    dir: f.root,
    agent: 'codex',
    runtime: 'app-server',
    chat: true,
    registrationGeneration: crypto.randomUUID(),
    delegation,
  });
  await writeSessionsUnlocked(f.m, [s]);
  await seedNativeSelection(f.m, s, {
    runtime: 'codex',
    model: { provider: 'openai', model: 'test-model' },
    mode: 'default',
  });
  const path = join(f.root, 'owner.json');
  writeFileSync(path, JSON.stringify({ m: f.m, s }), { mode: 0o600 });
  const child = Bun.spawn(
    [process.execPath, new URL('./sleepOwner.ts', import.meta.url).pathname, path],
    { stdout: 'pipe', stderr: 'inherit' },
  );
  cleanup.push(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
  });
  const reader = child.stdout.getReader(),
    first = await reader.read();
  reader.releaseLock();
  if (first.done) throw Error('owned fixture failed');
  const identity: { pid: number; providerPid: number } = JSON.parse(
    new TextDecoder().decode(first.value),
  );
  const projection = new OwnedCodexProjection(f.m, s, identity.providerPid);
  const writer = new OwnedCodexStatusWriter(f.m, s.name);
  await writer.write({
    ...projection.snapshot(),
    ...identity,
    connected: true,
    state: 'idle',
    reason: null,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
  });
  return { ...f, authority, s, child, identity, target: managedPeer(f.m.rcPrefix, s) };
}
