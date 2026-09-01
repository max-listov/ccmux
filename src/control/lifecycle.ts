import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import { customModel, prepareCustomHost } from '../agent/custom/host.ts';
import { stableJson } from '../agent/launchInputs.ts';
import { validateOpenCodeSelection } from '../agent/opencode/catalog.ts';
import { inheritAttachmentPins } from '../attachments/pins.ts';
import { managedPeer } from '../chat/identity.ts';
import { createManagedSession, createNativeBootstrap } from '../commands/create.ts';
import { blockingInbound } from '../commands/wait.ts';
import {
  type ResolvedControlLaunch,
  resolveControlLaunchRecipe,
  verifyManagedLaunchRecipe,
} from '../config/launchRecipes.ts';
import { validateModelSelection } from '../config/modelSelection.ts';
import { modelSelectionFlags } from '../config/modelSelectionFlags.ts';
import { loadPendingSessions } from '../config/pendingSessions.ts';
import { withDirectoryLock } from '../config/registryLock.ts';
import {
  AgentKindSchema,
  LaunchRecipeMetadataSchema,
  type ManagedPeerSchema,
  ModelSelectionSchema,
} from '../config/schema.ts';
import { archiveSessionExact, loadSessions } from '../config/sessions.ts';
import {
  type NativeForkSource,
  NativeForkSourceSchema,
  prepareNativeFork,
} from '../context/fork.ts';
import { type NativeForkRequest, NativeForkRequestSchema } from '../context/schema.ts';
import { assertNoContextMutation, nativeId } from '../context/store.ts';
import { projectApplicationPolicy } from '../policy/projection.ts';
import { resolveApplicationPolicy, verifyApplicationPolicy } from '../policy/resolve.ts';
import {
  type ApplicationPolicyMetadata,
  ApplicationPolicyMetadataSchema,
} from '../policy/schema.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { recordRuntimeDiagnostic } from '../runtime/diagnostics.ts';
import { readRuntimeInput } from '../runtime/input.ts';
import { readSelection } from '../runtime/selection.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import { killSession } from '../tmux/tmux.ts';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { log } from '../util/log.ts';
import type { ControlCreateSchema } from './schema.ts';
import { controlTarget } from './target.ts';

type CreateInput = z.input<typeof ControlCreateSchema>;
const CreateRowSchema = z
  .object({
    runtime: AgentKindSchema.optional(),
    requestId: z.uuid(),
    fingerprint: z.string().length(64),
    generation: z.uuid(),
    name: z.string(),
    workspace: z.string(),
    flags: z.array(z.string()),
    envFile: z.string().min(1).optional(),
    launchRecipe: LaunchRecipeMetadataSchema.optional(),
    modelSelection: ModelSelectionSchema.optional(),
    applicationPolicy: ApplicationPolicyMetadataSchema.optional(),
    /** The execution mode the caller asked for, where the agent offers a choice. */
    mode: z.enum(['tui', 'native']).optional(),
    forkSource: NativeForkSourceSchema.optional(),
    status: z.enum(['pending', 'complete', 'failed']),
    threadId: z.uuid().nullable(),
    error: z.string().max(512).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
type CreateRow = z.infer<typeof CreateRowSchema>;
type ForkAdmission = {
  source: NativeForkSource;
  launch: ResolvedControlLaunch & { applicationPolicy?: ApplicationPolicyMetadata };
};
const StoreSchema = z.array(CreateRowSchema).max(256);

const storePath = (m: Pick<MachineConfig, 'stateDir'>) =>
  join(m.stateDir, 'control', 'create-requests.json');
const storeLockPath = (m: Pick<MachineConfig, 'stateDir'>) =>
  join(m.stateDir, 'control', 'create-requests.lock');
const requestLockPath = (m: Pick<MachineConfig, 'stateDir'>, requestId: string) =>
  join(
    m.stateDir,
    'control',
    `create-${createHash('sha256').update(requestId).digest('hex').slice(0, 24)}.lock`,
  );
function load(m: MachineConfig): CreateRow[] {
  const path = storePath(m);
  if (!existsSync(path)) return [];
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 512 * 1024
    ) {
      throw new Error('unsafe create receipt store');
    }
    return StoreSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new AppError('CORRUPT_STATE', 'Create receipt store is unavailable', 503);
  }
}
async function save(m: MachineConfig, rows: CreateRow[]): Promise<void> {
  privateRuntimeDirectory(dirname(storePath(m)));
  await atomicWrite(storePath(m), JSON.stringify(StoreSchema.parse(rows)), 0o600);
}
const fingerprint = (input: {
  name: string;
  workspace: string;
  flags: string[];
  envFile?: string;
  launchRecipe?: unknown;
}) => createHash('sha256').update(stableJson(input)).digest('hex');
function normalizeWorkspace(path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    throw new AppError('INVALID_WORKSPACE', 'Workspace does not exist', 400);
  }
  const stat = lstatSync(resolved);
  if (!stat.isDirectory())
    throw new AppError('INVALID_WORKSPACE', 'Workspace is not a directory', 400);
  return resolved;
}
function matchingSession(m: MachineConfig, row: CreateRow): Session | null {
  return (
    loadSessions(m).find(
      (session) => session.name === row.name && session.registrationGeneration === row.generation,
    ) ?? null
  );
}

export async function createControlSession(
  m: MachineConfig,
  input: CreateInput,
  signal: AbortSignal,
  create: typeof createManagedSession = createManagedSession,
  validateSelection: typeof validateModelSelection = validateModelSelection,
  fork?: ForkAdmission,
) {
  const workspace = normalizeWorkspace(input.workspace);
  const runtime = input.runtime ?? 'codex';
  // The execution mode this create will actually use, resolved once so the capability checks below
  // ask about the session that will exist rather than about the agent family in general.
  const mode =
    runtime === 'codex' ? 'app-server' : runtime === 'claude' ? (input.mode ?? 'tui') : 'native';
  if (runtime !== 'codex' && runtime !== 'custom' && input.launchRecipe !== undefined)
    throw new AppError('UNSUPPORTED', 'This runtime does not accept a Codex launch recipe', 409);
  if (runtime !== 'codex' && (input.flags?.length ?? 0) > 0)
    throw new AppError(
      'INVALID_INPUT',
      'This runtime requires typed configuration without caller flags',
      400,
    );
  // Refused by capability, not by runtime name: the interactive mode's model is the provider's to
  // choose, and the native mode's is a turn option this project serves. Named for the agent, this
  // refused a fork of a native session — which must carry its source's model.
  if (
    input.modelSelection !== undefined &&
    !runtimeCapabilities({ agent: runtime, runtime: mode }).modelSelection
  )
    throw new AppError('UNSUPPORTED', 'Model selection is provider-owned for this runtime', 409);
  if (input.modelSelection !== undefined && (input.flags?.length ?? 0) > 0)
    throw new AppError('INVALID_INPUT', 'Typed model selection cannot carry caller flags', 400);
  const resolved =
    fork?.launch ??
    resolveControlLaunchRecipe(
      m,
      workspace,
      input.launchRecipe,
      input.flags ?? [],
      runtime === 'custom' ? 'custom' : 'codex',
    );
  let modelSelection = input.modelSelection;
  if (runtime === 'custom') {
    if (input.applicationPolicy !== undefined)
      throw new AppError('UNSUPPORTED', 'Custom composition is owned by its launch recipe', 409);
    try {
      const host = prepareCustomHost(m, { dir: workspace, ...resolved });
      modelSelection = customModel(host.config, input.modelSelection).selection;
    } catch (error) {
      await recordRuntimeDiagnostic(m, null, 'custom-create-preflight', error);
      throw new AppError('LAUNCH_RECIPE_UNAVAILABLE', 'Launch recipe is unavailable', 409);
    }
  }
  const applicationPolicy =
    fork?.launch.applicationPolicy ??
    (input.applicationPolicy === undefined
      ? undefined
      : resolveApplicationPolicy(m, runtime, input.applicationPolicy).metadata);
  const canonical = {
    name: input.name,
    workspace,
    flags: [
      ...resolved.flags,
      ...(runtime === 'codex' ? modelSelectionFlags(input.modelSelection) : []),
    ],
    ...(runtime === 'codex' ? {} : { runtime }),
    ...(resolved.envFile === undefined ? {} : { envFile: resolved.envFile }),
    ...(resolved.launchRecipe === undefined ? {} : { launchRecipe: resolved.launchRecipe }),
    ...(modelSelection === undefined ? {} : { modelSelection }),
    ...(applicationPolicy === undefined ? {} : { applicationPolicy }),
    // Part of the canonical request, so an identical retry matches and a request for a DIFFERENT
    // mode is a different request rather than a silent reuse of the accepted one.
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(fork === undefined ? {} : { forkSource: fork.source }),
  };
  const digest = fingerprint(canonical);
  const accepted = load(m).find((row) => row.requestId === input.requestId);
  if (accepted !== undefined && accepted.fingerprint !== digest)
    throw new AppError('IDEMPOTENCY_CONFLICT', 'Create request payload changed', 409);
  if (accepted === undefined && input.modelSelection !== undefined) {
    if (runtime === 'opencode')
      await validateOpenCodeSelection(m, workspace, input.modelSelection, signal);
    else if (runtime === 'codex')
      await validateSelection(m, resolved, workspace, input.modelSelection, signal);
  }
  privateRuntimeDirectory(dirname(storeLockPath(m)));
  return withDirectoryLock(
    requestLockPath(m, input.requestId),
    async () => {
      let row!: CreateRow;
      let duplicate = false;
      await withDirectoryLock(
        storeLockPath(m),
        async () => {
          const rows = load(m);
          const found = rows.find((item) => item.requestId === input.requestId);
          if (found) {
            if (found.fingerprint !== digest)
              throw new AppError('IDEMPOTENCY_CONFLICT', 'Create request payload changed', 409);
            row = found;
            duplicate = true;
            return;
          }
          const now = new Date().toISOString();
          row = CreateRowSchema.parse({
            requestId: input.requestId,
            fingerprint: digest,
            generation: crypto.randomUUID(),
            ...canonical,
            status: 'pending',
            threadId: null,
            error: null,
            createdAt: now,
            updatedAt: now,
          });
          if (rows.length >= 256)
            throw new AppError('CREATE_CAPACITY', 'Managed create receipt capacity reached', 409);
          await save(m, [...rows, row]);
        },
        'control create receipt',
      );
      signal.throwIfAborted();
      if (row.status === 'failed')
        throw new AppError('CREATE_FAILED', 'Managed session create failed', 409);
      let session = matchingSession(m, row);
      if (row.status === 'complete' && session === null)
        throw new AppError(
          'IDENTITY_MISMATCH',
          'The accepted managed registration no longer exists',
          409,
        );
      if (session === null) {
        const pending = loadPendingSessions(m).some((item) => item.generation === row.generation);
        if (!pending) {
          try {
            const agent = row.runtime ?? 'codex';
            if (row.forkSource !== undefined)
              await prepareNativeFork(m, row.generation, row.forkSource);
            session = await create(m, {
              name: row.name,
              dir: row.workspace,
              agent,
              flags: row.flags,
              router: false,
              // Claude is the only agent with a choice here; everything else has one mode, and an
              // omitted request keeps the mode each agent has always been created with.
              runtime:
                agent === 'codex'
                  ? 'app-server'
                  : agent === 'claude'
                    ? (row.mode ?? 'tui')
                    : 'native',
              registrationGeneration: row.generation,
              chatEnabled: true,
              ...(row.envFile === undefined ? {} : { envFile: row.envFile }),
              ...(row.launchRecipe === undefined ? {} : { launchRecipe: row.launchRecipe }),
              ...(row.modelSelection === undefined ? {} : { modelSelection: row.modelSelection }),
              ...(row.applicationPolicy === undefined
                ? {}
                : { applicationPolicy: row.applicationPolicy }),
            });
          } catch (error) {
            session = matchingSession(m, row);
            if (session === null) {
              const message = String(error).slice(0, 512);
              if (row.forkSource !== undefined) {
                log.error({
                  msg: 'managed native fork remains unresolved',
                  requestId: row.requestId,
                  error: message,
                });
                throw new AppError(
                  'FORK_PENDING',
                  'Native fork is unresolved; retry the same request',
                  503,
                );
              }
              await withDirectoryLock(
                storeLockPath(m),
                async () =>
                  save(
                    m,
                    load(m).map((item) =>
                      item.requestId === row.requestId
                        ? {
                            ...item,
                            status: 'failed' as const,
                            error: message,
                            updatedAt: new Date().toISOString(),
                          }
                        : item,
                    ),
                  ),
                'control create receipt',
              );
              log.error({
                msg: 'managed control create failed',
                requestId: row.requestId,
                recipeId: row.launchRecipe?.id ?? null,
                error: message,
              });
              throw new AppError('CREATE_FAILED', 'Managed session create failed', 409);
            }
          }
        }
      }
      const deadline = Date.now() + m.codexCorrelationTimeoutMs + 1_000;
      while (session === null && Date.now() < deadline) {
        signal.throwIfAborted();
        await Bun.sleep(50);
        session = matchingSession(m, row);
      }
      if (session === null)
        throw new AppError(
          'CREATE_PENDING',
          'Create is still reconciling; retry the same request',
          503,
        );
      if (
        session.agent !== (row.runtime ?? 'codex') ||
        session.dir !== row.workspace ||
        (row.threadId !== null && session.uuid !== row.threadId) ||
        stableJson(session.flags) !== stableJson(row.flags) ||
        session.envFile !== row.envFile ||
        stableJson(session.launchRecipe ?? null) !== stableJson(row.launchRecipe ?? null) ||
        stableJson(session.modelSelection ?? null) !== stableJson(row.modelSelection ?? null) ||
        stableJson(session.applicationPolicy ?? null) !== stableJson(row.applicationPolicy ?? null)
      )
        throw new AppError(
          'CORRUPT_STATE',
          'Managed create identity does not match its receipt',
          503,
        );
      const ready = session;
      if (row.forkSource !== undefined) {
        const source = controlTarget(m, row.forkSource.target);
        if (source.registrationGeneration !== row.forkSource.registration)
          throw new AppError('IDENTITY_MISMATCH', 'Native fork source registration changed', 409);
        await inheritAttachmentPins(m, source, ready, signal);
      }
      await withDirectoryLock(
        storeLockPath(m),
        async () =>
          save(
            m,
            load(m).map((item) =>
              item.requestId === row.requestId
                ? {
                    ...item,
                    status: 'complete' as const,
                    threadId: ready.uuid,
                    updatedAt: new Date().toISOString(),
                  }
                : item,
            ),
          ),
        'control create receipt',
      );
      const native =
        row.applicationPolicy === undefined ? null : readManagedRuntimeStatus(m, ready);
      return {
        requestId: row.requestId,
        target: managedPeer(m.rcPrefix, session),
        workspace: row.workspace,
        duplicate,
        registrationGeneration: row.generation,
        ...(row.launchRecipe === undefined ? {} : { launchRecipe: row.launchRecipe }),
        ...(row.modelSelection === undefined ? {} : { modelSelection: row.modelSelection }),
        ...(row.applicationPolicy === undefined
          ? {}
          : {
              applicationPolicy: projectApplicationPolicy(
                row.applicationPolicy,
                native?.status ?? 'unavailable',
                native?.snapshot?.applicationPolicy,
              ),
            }),
        ...(session.nativeSession === undefined ? {} : { nativeSession: session.nativeSession }),
        ...(row.runtime === undefined ? {} : { driverCapabilities: runtimeCapabilities(session) }),
      };
    },
    'control create request',
  );
}

/** One create journal reserves the destination before its own native server forks the source. */
export async function forkControlSession(
  m: MachineConfig,
  raw: NativeForkRequest,
  signal: AbortSignal,
) {
  const input = NativeForkRequestSchema.parse(raw),
    sourceTarget = input.target;
  const source = controlTarget(m, sourceTarget);
  return withNativeAdmission(m, source, async () => {
    const current = controlTarget(m, sourceTarget);
    const accepted = load(m).find((row) => row.requestId === input.requestId);
    if (
      accepted !== undefined &&
      (accepted.forkSource === undefined ||
        accepted.forkSource.registration !== current.registrationGeneration ||
        accepted.forkSource.registration !== input.registrationGeneration ||
        accepted.forkSource.generation !== input.generation ||
        accepted.name !== input.name ||
        stableJson(accepted.forkSource.target) !== stableJson(sourceTarget))
    )
      throw new AppError('IDEMPOTENCY_CONFLICT', 'Native fork source changed', 409);
    if (accepted === undefined) assertNoContextMutation(m, current);
    const status = readManagedRuntimeStatus(m, current);
    if (
      accepted === undefined &&
      (current.registrationGeneration !== input.registrationGeneration ||
        status.snapshot?.generation !== input.generation)
    )
      throw new AppError('IDENTITY_MISMATCH', 'Native fork source generation changed', 409);
    if (
      accepted === undefined &&
      (!current.registrationGeneration ||
        !nativeId(current) ||
        status.status !== 'live' ||
        !status.snapshot ||
        status.snapshot.state !== 'idle' ||
        status.snapshot.turn?.status === 'inProgress' ||
        status.snapshot.pendingRequests.length !== 0)
    )
      throw new AppError('FORK_BUSY', 'Native source must be idle before fork', 409);
    const pendingInput = readRuntimeInput(m, current);
    if (
      accepted === undefined &&
      (blockingInbound(m, current, Date.now()).length !== 0 ||
        (pendingInput !== null && pendingInput.phase !== 'accepted'))
    )
      throw new AppError('FORK_BUSY', 'Native source has accepted input pending', 409);
    // Asked of the declared capability, not of a list of runtime names: the capability is what the
    // control plane answers `runtime.list` with, and a name list beside it is a second answer that
    // goes stale the moment a runtime gains the operation.
    if (!runtimeCapabilities(current).fork)
      throw new AppError('UNSUPPORTED', 'Native fork is unavailable for this runtime', 409);
    const sourceIdentity =
      accepted?.forkSource ??
      NativeForkSourceSchema.parse({
        target: sourceTarget,
        registration: current.registrationGeneration,
        generation: status.snapshot?.generation,
        nativeId: nativeId(current),
        turnId: status.snapshot?.turn?.id ?? null,
        // The retained store holds only a selection somebody CHANGED; a session running its
        // admission default has none there, and reading only that store called every such session
        // unforkable. The snapshot's own selection is what the session is actually running.
        selection: readSelection(m, current)?.options ?? status.snapshot?.nativeSelection?.options,
      });
    if (sourceIdentity.selection === undefined)
      throw new AppError('FORK_UNAVAILABLE', 'Native source selection is unavailable', 409);
    const sourceLaunch = accepted ?? current;
    const modelFlags = modelSelectionFlags(sourceLaunch.modelSelection);
    const flags =
      modelFlags.length > 0 &&
      stableJson(sourceLaunch.flags.slice(-modelFlags.length)) === stableJson(modelFlags)
        ? sourceLaunch.flags.slice(0, -modelFlags.length)
        : [...sourceLaunch.flags];
    const launch = {
      flags,
      ...(sourceLaunch.envFile === undefined ? {} : { envFile: sourceLaunch.envFile }),
      ...(sourceLaunch.launchRecipe === undefined
        ? {}
        : { launchRecipe: sourceLaunch.launchRecipe }),
      ...(sourceLaunch.applicationPolicy === undefined
        ? {}
        : { applicationPolicy: sourceLaunch.applicationPolicy }),
    };
    const policySession = {
      ...current,
      ...launch,
      flags: sourceLaunch.flags,
      ...(sourceLaunch.modelSelection === undefined
        ? {}
        : { modelSelection: sourceLaunch.modelSelection }),
    };
    verifyManagedLaunchRecipe(m, policySession);
    if (launch.applicationPolicy !== undefined)
      verifyApplicationPolicy(m, current.agent, launch.applicationPolicy);
    return createControlSession(
      m,
      {
        requestId: input.requestId,
        name: input.name,
        workspace: accepted?.workspace ?? current.dir,
        runtime: current.agent,
        // The destination must run the SAME execution mode as its source: a fork of a native
        // conversation created as an interactive session would point a pane at a conversation
        // nothing is writing.
        ...(current.agent === 'claude' &&
        (current.runtime === 'native' || current.runtime === 'tui')
          ? { mode: current.runtime }
          : {}),
        flags: [],
        modelSelection: accepted?.modelSelection ?? sourceIdentity.selection.model,
      },
      signal,
      (machine, destination) =>
        createNativeBootstrap(machine, destination, { kind: 'fork', sourceThreadId: current.uuid }),
      validateModelSelection,
      { source: sourceIdentity, launch },
    );
  });
}

export async function archiveControlSession(
  m: MachineConfig,
  target: z.infer<typeof ManagedPeerSchema>,
) {
  const result = await archiveSessionExact(m, target.session, target.threadId);
  if (result === 'missing')
    throw new AppError('IDENTITY_MISMATCH', 'Managed identity changed or disappeared', 409);
  const stopped = await killSession(m, target.session);
  return { target, archived: true as const, duplicate: result === 'duplicate', stopped };
}
