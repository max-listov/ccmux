import { dirname } from 'node:path';
import { AppError } from 'stitchkit';
import type { z } from 'zod';
import { validateClaudeSelection } from '../agent/claude/native/catalog.ts';
import { customModel, prepareCustomHost } from '../agent/custom/host.ts';
import { stableJson } from '../agent/launch/launchInputs.ts';
import { validateOpenCodeSelection } from '../agent/opencode/catalog.ts';
import { inheritAttachmentPins } from '../attachments/pins.ts';
import { managedPeer } from '../chat/identity.ts';
import type { ManagedPeerSchema } from '../chat/identitySchema.ts';
import { resolveControlLaunchRecipe } from '../config/launchRecipes.ts';
import { validateModelSelection } from '../config/modelSelection.ts';
import { modelSelectionFlags } from '../config/modelSelectionFlags.ts';
import { prepareNativeFork } from '../context/fork.ts';
import { sessionApplicationPolicy } from '../policy/projection.ts';
import { resolveApplicationPolicy } from '../policy/resolve.ts';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { recordRuntimeDiagnostic } from '../runtime/diagnostics.ts';
import { resolveRuntimeMode } from '../runtime/modes.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import { privateRuntimeDirectory } from '../runtime/store.ts';
import { createManagedSession } from '../session/create.ts';
import { loadPendingSessions } from '../session/pending.ts';
import { archiveSessionExact } from '../session/registry.ts';
import { killSession } from '../tmux/tmux.ts';
import type { MachineConfig } from '../types.ts';
import { withLock } from '../util/lock.ts';
import { log } from '../util/log.ts';
import {
  type CreateInput,
  type CreateRow,
  CreateRowSchema,
  type ForkAdmission,
  fingerprint,
  loadCreateReceipts,
  matchingSession,
  normalizeWorkspace,
  requestLockPath,
  saveCreateReceipts,
  storeLockPath,
} from './createReceipts.ts';
import { controlTarget } from './target.ts';

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
  const mode = resolveRuntimeMode(runtime, input.mode);
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
  const accepted = loadCreateReceipts(m).find((row) => row.requestId === input.requestId);
  if (accepted !== undefined && accepted.fingerprint !== digest)
    throw new AppError('IDEMPOTENCY_CONFLICT', 'Create request payload changed', 409);
  if (accepted === undefined && input.modelSelection !== undefined) {
    if (runtime === 'opencode')
      await validateOpenCodeSelection(m, workspace, input.modelSelection, signal);
    else if (runtime === 'codex')
      await validateSelection(m, resolved, workspace, input.modelSelection, signal);
    else if (runtime === 'claude') validateClaudeSelection(m, input.modelSelection);
  }
  privateRuntimeDirectory(dirname(storeLockPath(m)));
  return withLock(
    requestLockPath(m, input.requestId),
    async () => {
      let row!: CreateRow;
      let duplicate = false;
      await withLock(
        storeLockPath(m),
        async () => {
          const rows = loadCreateReceipts(m);
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
          await saveCreateReceipts(m, [...rows, row]);
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
              runtime: resolveRuntimeMode(agent, row.mode),
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
              await withLock(
                storeLockPath(m),
                async () =>
                  saveCreateReceipts(
                    m,
                    loadCreateReceipts(m).map((item) =>
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
      await withLock(
        storeLockPath(m),
        async () =>
          saveCreateReceipts(
            m,
            loadCreateReceipts(m).map((item) =>
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
        ...sessionApplicationPolicy(m, session, row.applicationPolicy, native),
        ...(session.nativeSession === undefined ? {} : { nativeSession: session.nativeSession }),
        ...(row.runtime === undefined ? {} : { driverCapabilities: runtimeCapabilities(session) }),
      };
    },
    'control create request',
  );
}

export async function archiveControlSession(
  m: MachineConfig,
  target: z.infer<typeof ManagedPeerSchema>,
) {
  const result = await archiveSessionExact(m, target.session, target.threadId);
  if (result === 'missing')
    throw new AppError('IDENTITY_MISMATCH', 'Managed identity changed or disappeared', 409);
  const { killed: stopped } = await killSession(m, target.session);
  return { target, archived: true as const, duplicate: result === 'duplicate', stopped };
}
