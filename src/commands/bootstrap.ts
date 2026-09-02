import { z } from 'zod';
import { forkRolloutIdsForMarker, rolloutIdsForMarker } from '../agent/codex/correlation.ts';
import { buildAdoptArgv, buildForkArgv, CODEX_LAUNCH_MARKER_ENV } from '../agent/codex/launch.ts';
import { getProvider } from '../agent/index.ts';
import { CHAT_CREDENTIAL_ENV, rotateChatCredential } from '../chat/auth.ts';
import { writeLifecycleBlock } from '../config/lifecycleBlocks.ts';
import { loadMachineConfig } from '../config/machine.ts';
import {
  loadPendingSessions,
  markPendingBlocked,
  promotePendingSession,
  removePendingSession,
} from '../config/pendingSessions.ts';
import { SessionSchema } from '../config/schema.ts';
import { loadSessions, removeSessionIfGeneration } from '../config/sessions.ts';
import { readNativeForkIntent } from '../context/fork.ts';
import { promptInvocation } from '../env.ts';
import { codexLockHeldByDescendant } from '../external/codexLocks.ts';
import { nativeDriver } from '../runtime/driver.ts';
import { ManagedRuntimeExit } from '../runtime/exit.ts';
import { setStderrLogging } from '../util/log.ts';
import { superviseReady } from './run.ts';

const POLL_MS = 50;

/**
 * Why the correlation loop gave up, once its budget is spent. Two different facts can land in the
 * same instant — the budget ran out, and the child died — and the loop announces whichever it
 * noticed first. On a loaded host that is always the deadline: a sleep overshoots, the last
 * iteration eats what is left of the budget, and a child that crashed gets reported as a slow one.
 *
 * The two answers ask opposite things of whoever reads the block. A timeout points at host load or
 * a writer that would not admit us; a crash points at the child's own stderr, where the answer
 * already is. So the exit status decides, not whatever the loop happened to see, and it is read
 * before `kill` — after it, every child looks like one that exited on its own.
 */
export function exhaustedBudgetReason(
  kind: 'create' | 'fork' | 'adopt',
  exitCode: number | null,
): string {
  if (exitCode === null) return `Codex ${kind} admission/correlation timed out`;
  return kind === 'adopt'
    ? 'Codex resume admission was rejected by the active writer or child exited'
    : `Codex ${kind} child exited before writing session_meta`;
}

async function block(generation: string, error: string): Promise<number> {
  const m = loadMachineConfig();
  const pending = loadPendingSessions(m).find((item) => item.generation === generation);
  if (pending) {
    await markPendingBlocked(m, generation, error);
    await writeLifecycleBlock(m, {
      name: pending.session.name,
      agent: pending.session.agent,
      generation: pending.generation,
      error,
      at: new Date().toISOString(),
    });
    // The bootstrap owns terminal cleanup. The initiating CLI may have been killed, so leaving
    // rollback to its polling loop would reserve this name forever. The lifecycle block remains
    // as an identity-scoped error side channel for a still-alive initiator.
    const provisional = SessionSchema.parse({
      ...pending.session,
      uuid: pending.generation,
      registrationGeneration: generation,
    });
    const fork = pending.operation.kind === 'fork' ? readNativeForkIntent(m, provisional) : null;
    if (fork === null || fork.state === 'reserved') {
      await removeSessionIfGeneration(m, pending.session.name, generation);
      await removePendingSession(m, generation);
    }
  } else {
    // Admission may already have promoted the row. A later client/identity failure still needs
    // a terminal block; silently dropping it here would let the daemon retry indefinitely.
    const ready = loadSessions(m).find((session) => session.registrationGeneration === generation);
    if (ready !== undefined)
      await writeLifecycleBlock(m, {
        name: ready.name,
        agent: ready.agent,
        uuid: ready.uuid,
        generation,
        error,
        at: new Date().toISOString(),
      });
  }
  console.error(`ccmux: ${error}`);
  return 1;
}

/** Own one native bootstrap child, prove its provider identity/admission, then become the ready
 * supervisor. create/fork correlate persisted metadata; adopt proves this process tree owns the
 * provider's OS writer lock. */
export async function cmdBootstrap(rawGeneration: string | undefined): Promise<number> {
  const generation = z.uuid().parse(rawGeneration);
  const m = loadMachineConfig();
  const pending = loadPendingSessions(m).find((item) => item.generation === generation);
  if (pending?.status !== 'pending') return 1;
  setStderrLogging(false);
  const provider = getProvider(pending.session.agent);
  const provisional = SessionSchema.parse({
    ...pending.session,
    uuid: pending.generation,
    registrationGeneration: generation,
  });
  const driver = nativeDriver(provisional);
  if (driver !== null) {
    if (
      pending.operation.kind !== 'create' &&
      (pending.operation.kind !== 'fork' || readNativeForkIntent(m, provisional) === null)
    )
      return block(
        generation,
        'Native bootstrap requires an owner-admitted conversation operation',
      );
    try {
      await driver.run(m, provisional, (session) =>
        promotePendingSession(m, generation, session.uuid, session.nativeSession),
      );
      return 0;
    } catch (error) {
      if (error instanceof ManagedRuntimeExit)
        return superviseReady(m, provisional.name, provisional.agent);
      return block(generation, `Native bootstrap failed: ${String(error)}`);
    }
  }
  if (pending.session.agent !== 'codex')
    return block(generation, 'Interactive bootstrap requires Codex');
  const env = provider.launchEnv(m, provisional);
  env[CODEX_LAUNCH_MARKER_ENV] = pending.marker;
  env[CHAT_CREDENTIAL_ENV] = rotateChatCredential(m, provisional);
  const operation = pending.operation;
  const argv =
    operation.kind === 'create'
      ? provider.buildArgv(provisional, m, promptInvocation(), false)
      : operation.kind === 'adopt'
        ? buildAdoptArgv(provisional, m, operation.sourceThreadId)
        : buildForkArgv(
            provisional,
            m,
            operation.sourceThreadId,
            promptInvocation(),
            pending.marker,
          );
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: provisional.dir,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env,
    });
  } catch (error) {
    return block(generation, `Codex ${operation.kind} spawn failed: ${String(error)}`);
  }

  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  const deadline = Date.now() + m.codexCorrelationTimeoutMs;
  let readyUuid: string | null = null;
  while (Date.now() < deadline) {
    if (operation.kind === 'adopt') {
      if (codexLockHeldByDescendant(m, operation.sourceThreadId, proc.pid)) {
        readyUuid = operation.sourceThreadId;
        break;
      }
      if (exited)
        return block(
          generation,
          'Codex resume admission was rejected by the active writer or child exited',
        );
      await Bun.sleep(POLL_MS);
      continue;
    }
    const ids =
      operation.kind === 'fork'
        ? forkRolloutIdsForMarker(m, pending.marker, operation.sourceThreadId)
        : rolloutIdsForMarker(m, pending.marker);
    if (ids.length > 1) {
      proc.kill();
      return block(
        generation,
        `Codex ${operation.kind} marker matched ${ids.length} rollouts; refusing ambiguous promotion`,
      );
    }
    if (ids.length === 1) {
      readyUuid = ids[0] ?? null;
      break;
    }
    if (exited)
      return block(generation, `Codex ${operation.kind} child exited before writing session_meta`);
    await Bun.sleep(POLL_MS);
  }
  if (!readyUuid) {
    const reason = exhaustedBudgetReason(operation.kind, proc.exitCode);
    proc.kill();
    return block(generation, reason);
  }
  try {
    await promotePendingSession(m, generation, readyUuid);
  } catch (error) {
    proc.kill();
    return block(generation, `Codex promotion lost its CAS: ${String(error)}`);
  }

  await proc.exited;
  return superviseReady(m, provisional.name, 'codex');
}
