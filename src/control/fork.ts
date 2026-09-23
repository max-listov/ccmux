import { AppError } from 'stitchkit';
import { stableJson } from '../agent/launch/launchInputs.ts';
import { blockingInbound } from '../chat/inboundHold.ts';
import { verifyManagedLaunchRecipe } from '../config/launchRecipes.ts';
import { validateModelSelection } from '../config/modelSelection.ts';
import { modelSelectionFlags } from '../config/modelSelectionFlags.ts';
import { NativeForkSourceSchema } from '../context/fork.ts';
import { type NativeForkRequest, NativeForkRequestSchema } from '../context/schema.ts';
import { assertNoContextMutation, nativeId } from '../context/store.ts';
import { verifyApplicationPolicy } from '../policy/resolve.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { readRuntimeInput } from '../runtime/input.ts';
import { readSelection } from '../runtime/selection.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import { createNativeBootstrap } from '../session/create.ts';
import type { MachineConfig } from '../types.ts';
import { loadCreateReceipts } from './createReceipts.ts';
import { createControlSession } from './lifecycle.ts';
import { controlTarget } from './target.ts';

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
    const accepted = loadCreateReceipts(m).find((row) => row.requestId === input.requestId);
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
