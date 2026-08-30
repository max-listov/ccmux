import { createHash } from 'node:crypto';
import { AppError } from 'stitchkit';
import type { z } from 'zod';
import { preparedOpenCodeChoices } from '../agent/opencode/catalog.ts';
import { managedPeer } from '../chat/identity.ts';
import { blockingInbound } from '../commands/wait.ts';
import { assertNoContextMutation } from '../context/store.ts';
import { policyUnavailable } from '../policy/errors.ts';
import { verifyApplicationPolicy } from '../policy/resolve.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { hasNativeRuntime } from '../runtime/capabilities.ts';
import { readSelection, selectionReceipt, writeSelection } from '../runtime/selection.ts';
import type { AcceptedTurnOptions, NativeTurnOptions } from '../runtime/selectionSchema.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import type { MachineConfig, Session } from '../types.ts';
import { readControlModels } from './models.ts';
import { type ControlModel, ControlModelsReadSchema } from './schema.ts';
import {
  type SelectionReadSchema,
  SelectionResultSchema,
  type SelectionUpdateSchema,
} from './selectionSchema.ts';
import { controlTarget } from './target.ts';

export function exactNativeTarget(
  m: MachineConfig,
  input: z.output<typeof SelectionReadSchema>,
): Session {
  const session = controlTarget(m, input.target);
  if (!hasNativeRuntime(session) || session.archived)
    throw new AppError('UNSUPPORTED', 'An active managed native registration is required', 409);
  if (session.registrationGeneration !== input.registrationGeneration)
    throw new AppError('IDENTITY_MISMATCH', 'Managed registration changed', 409);
  return session;
}

async function catalog(m: MachineConfig, s: Session, signal: AbortSignal): Promise<ControlModel[]> {
  const rows: ControlModel[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 16; page++) {
    const result = await readControlModels(
      m,
      ControlModelsReadSchema.parse({ target: managedPeer(m.rcPrefix, s), cursor }),
      signal,
    );
    rows.push(...result.data);
    if (result.nextCursor === null) return rows;
    if (result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  throw new AppError('UNAVAILABLE', 'Model catalog exceeds the bounded selection window', 409);
}

export async function currentSelection(
  m: MachineConfig,
  s: Session,
  signal: AbortSignal,
): Promise<AcceptedTurnOptions> {
  signal.throwIfAborted();
  const retained = readSelection(m, s);
  if (retained !== null) return retained;
  const model = s.modelSelection;
  if (model === undefined)
    throw new AppError('UNAVAILABLE', 'Initial native selection has not been observed', 409);
  if (s.agent === 'codex')
    return {
      revision: 0,
      options: { runtime: 'codex', model, mode: s.launchRecipe?.collaborationMode ?? 'default' },
    };
  if (s.agent === 'opencode') return { revision: 0, options: { runtime: 'opencode', model } };
  throw new AppError('UNSUPPORTED', 'Native selection is unavailable', 409);
}

export async function validateTurnOptions(
  m: MachineConfig,
  s: Session,
  options: NativeTurnOptions,
  signal: AbortSignal,
  images = false,
): Promise<void> {
  if (options.runtime !== s.agent)
    throw new AppError('UNSUPPORTED', 'Selection runtime differs from its session', 409);
  if (options.runtime === 'opencode' && s.applicationPolicy !== undefined) {
    const policy = verifyApplicationPolicy(m, 'opencode', s.applicationPolicy);
    if (policy.runtime !== 'opencode')
      policyUnavailable(policy.metadata.id, 'opencode-policy-required');
    if (options.agent !== undefined && options.agent !== policy.agent.name)
      policyUnavailable(policy.metadata.id, 'native-agent-selection-conflicts-with-policy');
  }
  const models = await catalog(m, s, signal);
  const row = models.find(
    (item) =>
      (item.model ?? item.id) === options.model.model &&
      (item.provider ?? 'openai') === options.model.provider,
  );
  if (row === undefined || (images && !row.inputModalities.includes('image')))
    throw new AppError('UNSUPPORTED', 'Requested model or input modality is unavailable', 409);
  if (
    options.runtime === 'codex' &&
    options.effort !== undefined &&
    !row.supportedReasoningEfforts?.some((item) => item.reasoningEffort === options.effort)
  )
    throw new AppError('UNSUPPORTED', 'Requested reasoning effort is unavailable', 409);
  if (options.runtime === 'opencode') {
    const choices = preparedOpenCodeChoices(m, s);
    if (
      (options.agent !== undefined && !choices.agents.includes(options.agent)) ||
      (options.variant !== undefined && !row.variants?.includes(options.variant))
    )
      throw new AppError('UNSUPPORTED', 'Requested native agent or variant is unavailable', 409);
  }
}

export function requireNativeIdle(m: MachineConfig, s: Session): void {
  assertNoContextMutation(m, s);
  const read = readManagedRuntimeStatus(m, s);
  if (
    read.status !== 'live' ||
    read.snapshot?.state !== 'idle' ||
    read.snapshot.turn?.status === 'inProgress' ||
    read.snapshot.pendingRequests.length > 0 ||
    blockingInbound(m, s, Date.now()).length > 0
  )
    throw new AppError('BUSY', 'Native session is not between turns', 409);
}

export async function readControlSelection(
  m: MachineConfig,
  input: z.output<typeof SelectionReadSchema>,
  signal: AbortSignal,
) {
  const session = exactNativeTarget(m, input);
  return SelectionResultSchema.parse({
    protocol: 1,
    registrationGeneration: input.registrationGeneration,
    current: await currentSelection(m, session, signal),
  });
}

export async function updateControlSelection(
  m: MachineConfig,
  input: z.output<typeof SelectionUpdateSchema>,
  signal: AbortSignal,
) {
  const session = exactNativeTarget(m, input);
  return withNativeAdmission(m, session, async () => {
    signal.throwIfAborted();
    exactNativeTarget(m, input);
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior = selectionReceipt(m, session, input.operationId, fingerprint);
    if (prior !== null) {
      return SelectionResultSchema.parse({
        protocol: 1,
        registrationGeneration: input.registrationGeneration,
        current: prior,
      });
    }
    requireNativeIdle(m, session);
    const current = await currentSelection(m, session, signal);
    if (current.revision !== input.expectedRevision)
      throw new AppError('REVISION_CONFLICT', 'Session selection changed', 409);
    await validateTurnOptions(m, session, input.options, signal);
    const result = SelectionResultSchema.parse({
      protocol: 1,
      registrationGeneration: input.registrationGeneration,
      current: { revision: current.revision + 1, options: input.options },
    });
    // Defaults and the retry receipt share one atomic record. No half-applied selection exists.
    await writeSelection(m, session, result.current, input.operationId, fingerprint);
    return result;
  });
}
