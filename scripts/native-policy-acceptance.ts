#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadMachineConfig } from '../src/config/machine.ts';
import { loadPendingSessions } from '../src/config/pendingSessions.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import type {
  ControlCreate,
  ControlCreateReceipt,
  ControlNativeSnapshot,
} from '../src/control/schema.ts';
import { ApiError } from '../src/control/serviceDescriptor.ts';
import { readManagedRuntimeStatus } from '../src/runtime/status.ts';
import { killSession, listSessionNames } from '../src/tmux/tmux.ts';
import type { ManagedPeer, Session } from '../src/types.ts';
import { atomicWrite } from '../src/util/atomic.ts';
import {
  check,
  createPolicyFixture,
  hash,
  policyService,
  report,
  retainReports,
  spawnCount,
  until,
} from './native-policy-fixture.ts';

const requestedRoot = process.argv[2];
if (requestedRoot === undefined) {
  const fixture = await createPolicyFixture();
  const env: Record<string, string | undefined> = { ...fixture.env };
  delete env.CCMUX_SESSION;
  delete env.CCMUX_CHAT_CREDENTIAL;
  const child = Bun.spawn([process.execPath, '--no-env-file', import.meta.filename, fixture.root], {
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  report('isolated-probe', {
    directoryHash: hash(fixture.root),
    retainedDirectoryName: basename(fixture.root),
  });
  process.exit(await child.exited);
}
const root = requestedRoot;
check(basename(root).startsWith('ccmux-policy-e2e-'), 'Not an isolated policy probe directory');
retainReports(root);
const m = loadMachineConfig();
check(
  m.stateDir === join(root, 'state') &&
    m.tmuxSocket?.startsWith('ccmux-policy-') &&
    !m.telegram &&
    Object.keys(m.fleet ?? {}).length === 0,
  'Not an isolated runtime',
);
const secret = readFileSync(join(root, 'private-fixture.txt'), 'utf8');
const privateSources = Object.values(m.agentPolicies).flatMap((policy) =>
  policy.runtime === 'codex'
    ? [...policy.instructionSources, ...policy.skills]
    : [policy.agent.source],
);
const inspect = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  check(!text.includes(secret), 'Private fixture value escaped through public service');
  for (const source of privateSources)
    check(!text.includes(source.path), 'Private policy source path escaped through public service');
};
const service = policyService(m, inspect);
let local = createControlClient({ socket: controlSocket(m) });
const cli = join(process.cwd(), 'src/cli.ts');
const spawnDaemon = () =>
  Bun.spawn([process.execPath, '--no-env-file', cli, 'daemon'], {
    env: process.env,
    stdin: 'ignore',
    stdout: Bun.file(join(root, 'daemon.log')),
    stderr: Bun.file(join(root, 'daemon-error.log')),
  });
let daemon = spawnDaemon();
const accepted: Array<{ request: ControlCreate; receipt: ControlCreateReceipt; session: Session }> =
  [];

async function ready(target: ManagedPeer) {
  await until('native live idle', async () => {
    try {
      const row = await service.get({ target });
      return row.availability === 'live' && row.state === 'idle';
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAVAILABLE') return false;
      throw error;
    }
  });
}

async function proof(target: ManagedPeer, variant: string, nativeToken: string) {
  await ready(target);
  const before = await service.native({ target });
  const message = {
    target,
    messageId: crypto.randomUUID(),
    body: 'Return the verification tokens required by your loaded application policy and selected native skill or agent. Do not use tools.',
  };
  const sent = await service.message(message);
  check(
    sent.accepted && !sent.duplicate && (await service.message(message)).duplicate,
    'Message idempotency failed',
  );
  let verified: ControlNativeSnapshot | null = null;
  await until('real native policy consumption', async () => {
    const frame = await service.native({
      target,
      cursor: { generation: before.generation, sequence: before.sequence },
    });
    const text = [...frame.baseline, ...frame.records]
      .filter((item) => item.kind === 'assistant')
      .map((item) => item.text ?? '')
      .join('');
    check(frame.pending.length === 0, 'Text-only policy probe unexpectedly requires native input');
    const result = await service.wait({ target, timeoutMs: 1000 });
    check(
      result.outcome !== 'failed' && result.outcome !== 'interrupted',
      'Native policy turn failed',
    );
    if (
      text.includes(`POLICY_${variant.toUpperCase()}`) &&
      text.includes(nativeToken) &&
      result.outcome === 'completed'
    ) {
      check(
        !text.includes(variant === 'alpha' ? 'POLICY_BETA' : 'POLICY_ALPHA'),
        'Distinct policy profiles contaminated each other',
      );
      verified = frame;
      return true;
    }
    return false;
  });
  check(verified, 'No native policy proof');
  const frame = await service.native({ target });
  check(
    frame.applicationPolicy?.state === 'applied',
    'Positive native consumption lacks applied policy evidence',
  );
  check(
    !JSON.stringify(frame.applicationPolicy).includes(root),
    'Policy metadata exposed owner paths',
  );
  const snapshot = readManagedRuntimeStatus(
    m,
    loadSessions(m).find((item) => item.uuid === target.threadId) ?? fail('Missing registration'),
  ).snapshot;
  check(snapshot?.providerPid, 'No positive provider PID baseline');
  const argv = Bun.spawnSync(['ps', '-p', String(snapshot.providerPid), '-o', 'command='], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  check(
    argv.exitCode === 0 && argv.stdout.length > 0,
    'Provider argv probe has no positive result',
  );
  inspect(argv.stdout.toString());
  check(
    !argv.stdout.toString().includes(`POLICY_${variant.toUpperCase()}`) &&
      !argv.stdout.toString().includes(nativeToken),
    'Policy body leaked into argv',
  );
  report('native-policy-consumed', {
    runtime: target.agent,
    targetHash: hash(target.threadId),
    policy: frame.applicationPolicy,
    nativeToken,
    liveContent: true,
    messageIdempotent: true,
    argvPrivate: true,
  });
  return frame;
}
function fail(message: string): never {
  throw new Error(message);
}

async function refusedBeforeSpawn(request: ControlCreate, runtime: 'codex' | 'opencode') {
  const writers = spawnCount(root, runtime);
  const sessions = JSON.stringify(loadSessions(m));
  const pending = JSON.stringify(loadPendingSessions(m));
  try {
    await service.create(request);
    throw new Error('Unavailable policy was accepted');
  } catch (error) {
    check(
      error instanceof ApiError && error.code === 'APPLICATION_POLICY_UNAVAILABLE',
      'Policy refusal did not use the generic error',
    );
    inspect(error.message);
  }
  check(spawnCount(root, runtime) === writers, 'Refused policy spawned a native process');
  check(
    JSON.stringify(loadSessions(m)) === sessions &&
      JSON.stringify(loadPendingSessions(m)) === pending,
    'Refused policy changed registration state',
  );
}

try {
  await until(
    'empty source-daemon baseline',
    async () => {
      try {
        return (await local.list()).status === 'live';
      } catch {
        return false;
      }
    },
    20_000,
  );
  check(
    loadSessions(m).length === 0 && (await listSessionNames(m)).size === 0,
    'Probe baseline is not empty',
  );
  const runtimes = await service.runtimes({});
  check(
    ['codex', 'opencode'].every((runtime) =>
      runtimes.runtimes.some((row) => row.runtime === runtime && row.availability === 'configured'),
    ),
    'Both native runtimes must be configured',
  );
  let cursor: string | null = null;
  let external: { provider: string; model: string } | undefined;
  do {
    const catalog = await service.models({ runtime: 'opencode', cursor });
    const selected = catalog.data.find(
      (row) => row.provider === 'openrouter' && row.model === 'z-ai/glm-5.3-flash',
    );
    if (selected?.provider && selected.model)
      external = { provider: selected.provider, model: selected.model };
    cursor = catalog.nextCursor;
  } while (external === undefined && cursor !== null);
  check(
    external,
    'Existing configured external acceptance model is absent from the native catalog',
  );
  report('native-catalog', { codexModel: 'gpt-5.6-luna', external });
  for (const runtime of ['codex', 'opencode']) {
    check(runtime === 'codex' || runtime === 'opencode', 'Invalid probe runtime');
    for (const variant of ['alpha', 'beta']) {
      const request: ControlCreate = {
        runtime,
        requestId: crypto.randomUUID(),
        name: `${runtime}-${variant}`,
        workspace: join(root, variant),
        applicationPolicy: { id: `${runtime}-${variant}`, revision: '1' },
        modelSelection:
          runtime === 'codex' ? { provider: 'openai', model: 'gpt-5.6-luna' } : external,
      };
      await refusedBeforeSpawn(
        { ...request, applicationPolicy: { id: 'not-defined', revision: '1' } },
        runtime,
      );
      await refusedBeforeSpawn(
        { ...request, applicationPolicy: { id: `${runtime}-${variant}`, revision: 'different' } },
        runtime,
      );
      const receipt = await service.create(request);
      const retry = await service.create(request);
      check(
        retry.duplicate && JSON.stringify(retry.target) === JSON.stringify(receipt.target),
        'Create retry changed managed identity',
      );
      check(
        receipt.registrationGeneration === retry.registrationGeneration,
        'Create retry changed registration generation',
      );
      const session = loadSessions(m).find((row) => row.uuid === receipt.target.threadId);
      check(session, 'Accepted session missing from registry');
      accepted.push({ request, receipt, session });
      await proof(
        receipt.target,
        variant,
        runtime === 'codex' ? 'SKILL_CONSUMED' : 'AGENT_CONSUMED',
      );
      const policy = m.agentPolicies[`${runtime}-${variant}`];
      check(policy, 'Fixture policy disappeared');
      const source = policy.runtime === 'codex' ? policy.skills[0] : policy.agent.source;
      check(source, 'Fixture source is absent');
      const original = readFileSync(source.path, 'utf8');
      try {
        await atomicWrite(source.path, `${original}\nChanged required source.\n`, 0o600);
        await refusedBeforeSpawn(request, runtime);
        await refusedBeforeSpawn(
          { ...request, requestId: crypto.randomUUID(), name: `${runtime}-${variant}-changed` },
          runtime,
        );
      } finally {
        await atomicWrite(source.path, original, 0o600);
      }
      report('policy-admission', {
        runtime,
        variant,
        unknownAndRevisionRefused: true,
        changedAndLateRetryRefused: true,
        noRegistryMutation: true,
        noProviderSpawn: true,
        oneRegistration: loadSessions(m).filter((row) => row.uuid === session.uuid).length === 1,
      });
    }
  }
  const prior = accepted.map(
    ({ session }) =>
      readManagedRuntimeStatus(m, session).snapshot ?? fail('Missing restart baseline'),
  );
  const daemonGeneration = (await local.list()).generation;
  daemon.kill('SIGTERM');
  await daemon.exited;
  await local.close();
  local = createControlClient({ socket: controlSocket(m) });
  check(
    accepted.every(
      ({ session }, index) =>
        readManagedRuntimeStatus(m, session).snapshot?.providerPid === prior[index]?.providerPid,
    ),
    'Daemon shutdown replaced a native writer',
  );
  daemon = spawnDaemon();
  await until(
    'new source daemon',
    async () => {
      try {
        const now = await local.list();
        return now.status === 'live' && now.generation !== daemonGeneration;
      } catch {
        return false;
      }
    },
    20_000,
  );
  for (const { request, receipt, session } of accepted) {
    await ready(receipt.target);
    check(
      (await service.get({ target: receipt.target })).applicationPolicy?.state === 'applied',
      'Daemon restart lost applied evidence',
    );
    const generation = (await service.native({ target: receipt.target })).generation;
    await killSession(m, session.name);
    const policy = m.agentPolicies[request.applicationPolicy?.id ?? ''];
    check(
      policy && (session.agent === 'codex' || session.agent === 'opencode'),
      'Restart policy missing',
    );
    const source = policy.runtime === 'codex' ? policy.instructionSources[0] : policy.agent.source;
    check(source, 'Restart canonical source missing');
    const original = readFileSync(source.path, 'utf8');
    const count = spawnCount(root, session.agent);
    const refusalCount = () =>
      readFileSync(join(root, 'state', 'ccmux.log'), 'utf8')
        .split('\n')
        .filter(
          (line) =>
            line.includes('"msg":"application policy unavailable"') &&
            line.includes(`"policyId":"${request.applicationPolicy?.id}"`),
        ).length;
    const refused = refusalCount();
    try {
      await atomicWrite(source.path, `${original}\nChanged restart source.\n`, 0o600);
      await service.start({ target: receipt.target });
      await until(
        'restart source validation refusal',
        async () => refusalCount() > refused,
        15_000,
      );
      check(
        spawnCount(root, session.agent) === count,
        'Changed source spawned a provider during restart',
      );
    } finally {
      await killSession(m, session.name);
      await atomicWrite(source.path, original, 0o600);
    }
    await service.start({ target: receipt.target });
    await until(
      'same-identity provider restart',
      async () => {
        try {
          return (await service.native({ target: receipt.target })).generation !== generation;
        } catch {
          return false;
        }
      },
      30_000,
    );
    const resumed = loadSessions(m).find((row) => row.uuid === session.uuid);
    check(
      resumed?.registrationGeneration === session.registrationGeneration &&
        resumed?.nativeSession?.id === session.nativeSession?.id,
      'Provider restart changed identity',
    );
    check(
      (await service.create(request)).duplicate,
      'Late create retry after restart created another writer',
    );
    await proof(
      receipt.target,
      request.name.endsWith('alpha') ? 'alpha' : 'beta',
      session.agent === 'codex' ? 'SKILL_CONSUMED' : 'AGENT_CONSUMED',
    );
    await service.archive({ target: receipt.target });
    report('restart-and-archive', {
      runtime: session.agent,
      targetHash: hash(session.uuid),
      daemonRestart: true,
      providerRestart: true,
      exactIdentity: true,
      immutablePolicy: true,
      changedRestartSourceRefusedBeforeSpawn: true,
      archived: true,
    });
  }
  report('completed', {
    realNativeRuntimes: 2,
    distinctPolicies: accepted.length,
    serviceRevision: '2',
    allChecksPassed: true,
  });
} catch (error) {
  await atomicWrite(
    join(root, 'failure.txt'),
    error instanceof Error ? `${error.stack}\n` : String(error),
    0o600,
  );
  report('failed', {
    kind: error instanceof ApiError ? error.code : 'probe-assertion',
    detailsRetainedPrivately: true,
  });
  process.exitCode = 1;
} finally {
  for (const row of loadSessions(m).filter((item) => !item.archived)) {
    const entry = accepted.find((item) => item.session.uuid === row.uuid);
    if (entry) await service.archive({ target: entry.receipt.target }).catch(() => {});
  }
  for (const name of await listSessionNames(m)) await killSession(m, name).catch(() => {});
  daemon.kill('SIGTERM');
  await daemon.exited;
  await local.close();
  report('cleanup', {
    remainingManagedPanes: (await listSessionNames(m)).size,
    evidenceRetained: true,
  });
}
