import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { AppError } from 'stitchkit';
import { customModel, prepareCustomHost } from '../agent/custom/host.ts';
import { getProvider } from '../agent/index.ts';
import { clearLifecycleBlockIfGeneration, readLifecycleBlock } from '../config/lifecycleBlocks.ts';
import type { ModelSelection } from '../config/modelSelectionFlags.ts';
import {
  loadPendingSessions,
  removePendingSession,
  reservePendingSession,
} from '../config/pendingSessions.ts';
import { PendingSessionSchema, SessionSchema } from '../config/schema.ts';
import {
  appendSession,
  findSession,
  loadSessions,
  removeSessionIfGeneration,
  removeSessionIfUuid,
} from '../config/sessions.ts';
import { readNativeForkIntent } from '../context/fork.ts';
import { policyUnavailable } from '../policy/errors.ts';
import { verifyApplicationPolicy } from '../policy/resolve.ts';
import type { ApplicationPolicyMetadata } from '../policy/schema.ts';
import { runtimeAvailability } from '../runtime/availability.ts';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { nativeDriver } from '../runtime/driver.ts';
import {
  hasNativeRuntime,
  type RuntimeMode,
  runtimeModeIsValid,
  runtimeModes,
} from '../runtime/modes.ts';
import { killSessionIfGeneration } from '../tmux/tmux.ts';
import type {
  AgentKind,
  LaunchRecipeMetadata,
  MachineConfig,
  PendingSession,
  Session,
} from '../types.ts';
import { startBootstrapSession, startSession } from './lifecycle.ts';

export type CreateManagedInput = {
  name: string;
  dir: string;
  agent: AgentKind;
  flags: string[];
  router: boolean;
  runtime?: string;
  registrationGeneration?: string;
  chatEnabled?: boolean;
  /** Declared at creation so the session's very FIRST launch already runs the recipe it will keep —
   *  otherwise a session is born inheriting and has to be migrated the day it is made. */
  envFile?: string;
  launchRecipe?: LaunchRecipeMetadata;
  modelSelection?: ModelSelection;
  applicationPolicy?: ApplicationPolicyMetadata;
  /** Whether the runtime keeps a copy of every file this session modifies. Off unless asked. */
  fileCheckpoints?: boolean;
};

export type NativeBootstrapOperation =
  | { kind: 'create' }
  | { kind: 'adopt'; sourceThreadId: string }
  | { kind: 'fork'; sourceThreadId: string };

/**
 * The mode a created session is recorded with.
 *
 * Omitted means the agent's own default, except for the two that have an interactive mode: there
 * an omitted runtime stays omitted, which is how every session of those two has always been
 * stored. Written once because the policy check below asks the same question, and answering it a
 * second way is how the two came to disagree.
 */
function storedRuntime(input: CreateManagedInput): RuntimeMode | undefined {
  if (input.runtime !== undefined) return input.runtime as RuntimeMode;
  const declared = runtimeModes[input.agent];
  return declared.interactive === null ? declared.native : undefined;
}

function sessionFields(input: CreateManagedInput): Omit<Session, 'uuid'> {
  return SessionSchema.omit({ uuid: true }).parse({
    name: input.name,
    dir: input.dir,
    agent: input.agent,
    flags: input.flags,
    runtime: storedRuntime(input),
    ...(input.router ? { promptModules: ['router'], chatEnabled: true } : {}),
    ...(input.chatEnabled === undefined ? {} : { chatEnabled: input.chatEnabled }),
    ...(input.envFile === undefined ? {} : { envFile: input.envFile }),
    ...(input.launchRecipe === undefined ? {} : { launchRecipe: input.launchRecipe }),
    ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
    ...(input.fileCheckpoints === undefined ? {} : { fileCheckpoints: input.fileCheckpoints }),
    ...(input.applicationPolicy === undefined
      ? {}
      : { applicationPolicy: input.applicationPolicy }),
  });
}

function verifyCreatePolicy(m: MachineConfig, input: CreateManagedInput): void {
  if (input.applicationPolicy === undefined) return;
  // Asked as a capability, not as a list of names: an application policy is something a runtime
  // either accepts or does not, and it is already declared per runtime. Spelled out by name here,
  // this list quietly disagreed with the declaration two files away.
  const runtime = storedRuntime(input);
  if (!runtimeCapabilities({ agent: input.agent, runtime }).applicationPolicy)
    policyUnavailable(input.applicationPolicy.id, 'native-runtime-required');
  verifyApplicationPolicy(m, input.agent, input.applicationPolicy);
}

async function createClaude(m: MachineConfig, input: CreateManagedInput): Promise<Session> {
  const session = SessionSchema.parse({
    ...sessionFields(input),
    uuid: randomUUID(),
    registrationGeneration: input.registrationGeneration,
  });
  await appendSession(m, session);
  try {
    await startSession(m, session.name, session.dir);
    return session;
  } catch (error) {
    await removeSessionIfUuid(m, session.name, session.uuid);
    throw error;
  }
}

async function rollbackPending(
  m: MachineConfig,
  pending: PendingSession,
  error: string,
): Promise<never> {
  const provisional = SessionSchema.parse({
    ...pending.session,
    uuid: pending.generation,
    registrationGeneration: pending.generation,
  });
  const fork = pending.operation.kind === 'fork' ? readNativeForkIntent(m, provisional) : null;
  // Provider fork has no idempotency key. Preserve its reserved registration after uncertain admission.
  if (fork !== null && fork.state !== 'reserved') throw new Error(error);
  await killSessionIfGeneration(m, pending.session.name, pending.generation);
  await removePendingSession(m, pending.generation);
  await removeSessionIfGeneration(m, pending.session.name, pending.generation);
  await clearLifecycleBlockIfGeneration(m, pending.session.name, pending.generation);
  throw new Error(error);
}

export async function createNativeBootstrap(
  m: MachineConfig,
  input: CreateManagedInput,
  operation: NativeBootstrapOperation,
): Promise<Session> {
  verifyCreatePolicy(m, input);
  nativeDriver(sessionFields(input))?.preflight(m, input.flags);
  getProvider(input.agent).preflight(m);
  if (
    findSession(loadSessions(m), input.name) ||
    loadPendingSessions(m).some((item) => item.session.name === input.name)
  ) {
    throw new Error(`'${input.name}' already exists`);
  }
  const generation = input.registrationGeneration ?? randomUUID();
  const pending = PendingSessionSchema.parse({
    generation,
    marker: `ccmux_${generation}`,
    operation,
    session: sessionFields(input),
    createdAt: new Date().toISOString(),
    status: 'pending',
  });
  await reservePendingSession(m, pending);
  try {
    await startBootstrapSession(m, pending.session.name, pending.session.dir, pending.generation);
  } catch (error) {
    return rollbackPending(
      m,
      pending,
      `Native ${operation.kind} bootstrap could not start: ${String(error)}`,
    );
  }
  const deadline = Date.now() + m.codexCorrelationTimeoutMs + 1_000;
  while (Date.now() < deadline) {
    const ready = findSession(loadSessions(m), pending.session.name);
    if (ready?.registrationGeneration === generation) return ready;
    if (ready)
      return rollbackPending(m, pending, 'Session name was claimed by another create transaction');
    const current = loadPendingSessions(m).find((item) => item.generation === generation);
    if (!current) {
      const rebound = findSession(loadSessions(m), pending.session.name);
      if (rebound?.registrationGeneration === generation) return rebound;
      if (rebound)
        return rollbackPending(
          m,
          pending,
          'Session name was claimed by another create transaction',
        );
      const block = readLifecycleBlock(m, pending.session.name);
      const error =
        block?.generation === generation
          ? block.error
          : `Native ${operation.kind} bootstrap disappeared before promotion`;
      return rollbackPending(m, pending, error);
    }
    if (current.status === 'blocked')
      return rollbackPending(m, pending, current.error ?? 'Native bootstrap blocked');
    await Bun.sleep(50);
  }
  return rollbackPending(m, pending, `Native ${operation.kind} correlation timed out`);
}

function externalCodexName(
  m: MachineConfig,
  dir: string,
  threadId: string,
  wantName?: string,
): string {
  const sessions = loadSessions(m);
  const base = wantName ?? `cc-${basename(dir)}`;
  if (
    !findSession(sessions, base) &&
    !loadPendingSessions(m).some((item) => item.session.name === base)
  )
    return base;
  return `${base}-${threadId.slice(0, 4)}`;
}

export async function adoptCodexThread(
  m: MachineConfig,
  dir: string,
  threadId: string,
  wantName?: string,
): Promise<Session> {
  return createNativeBootstrap(
    m,
    {
      name: externalCodexName(m, dir, threadId, wantName),
      dir,
      agent: 'codex',
      flags: [],
      router: false,
    },
    { kind: 'adopt', sourceThreadId: threadId },
  );
}

export async function forkCodexThread(
  m: MachineConfig,
  dir: string,
  sourceThreadId: string,
  wantName?: string,
): Promise<Session> {
  return createNativeBootstrap(
    m,
    {
      name: externalCodexName(m, dir, sourceThreadId, wantName),
      dir,
      agent: 'codex',
      flags: [],
      router: false,
    },
    { kind: 'fork', sourceThreadId },
  );
}

/** Shared transactional create path for CLI and TUI. */
export async function createManagedSession(
  m: MachineConfig,
  input: CreateManagedInput,
): Promise<Session> {
  verifyCreatePolicy(m, input);
  const fields = sessionFields(input);
  if (fields.runtime !== undefined && !runtimeModeIsValid(fields.agent, fields.runtime))
    throw new Error(`${fields.agent} has no ${fields.runtime} runtime`);
  // Asked of the host, not derived from the agent's name: whether a mode is enabled here is what
  // `runtimeAvailability` answers, and it distinguishes "not enabled" from "not installed".
  if (
    fields.runtime !== undefined &&
    runtimeAvailability(m, fields.agent, fields.runtime).reason === 'runtime-not-enabled'
  )
    throw new AppError('UNAVAILABLE', 'The native Claude runtime is not enabled on this host', 409);
  if (fields.runtime === undefined && runtimeModes[fields.agent].interactive === null)
    throw new Error('This provider requires a native runtime');
  nativeDriver(fields)?.preflight(m, input.flags);
  if (fields.agent === 'custom')
    customModel(prepareCustomHost(m, fields).config, fields.modelSelection);
  getProvider(input.agent).preflight(m);
  if (
    findSession(loadSessions(m), input.name) ||
    loadPendingSessions(m).some((item) => item.session.name === input.name)
  ) {
    throw new Error(`'${input.name}' already exists`);
  }
  // Everything except an interactive Claude session comes up through the native bootstrap, which
  // pins a provider continuation before the session is registered. Stated as the one exception it
  // is, rather than as a list of the agents that are not it.
  return fields.agent === 'claude' && !hasNativeRuntime(fields)
    ? createClaude(m, input)
    : createNativeBootstrap(m, input, { kind: 'create' });
}
