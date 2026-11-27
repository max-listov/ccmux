import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { stableJson } from '../agent/launch/launchInputs.ts';
import { preparedOpenCodeChoices } from '../agent/opencode/catalog.ts';
import { managedPeer } from '../chat/identity.ts';
import { blockingInbound } from '../chat/inboundHold.ts';
import { assertNoContextMutation } from '../context/store.ts';
import { policyUnavailable } from '../policy/errors.ts';
import { verifyApplicationPolicy } from '../policy/resolve.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';

import {
  initialTurnOptions,
  readSelection,
  selectionReceipt,
  writeSelection,
} from '../runtime/selection.ts';
import {
  type AcceptedTurnOptions,
  modelSelectionLabel,
  type NativeTurnOptions,
} from '../runtime/selectionSchema.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import type { MachineConfig, Session } from '../types.ts';
import { readControlModels } from './models.ts';
import { type ControlModel, ControlModelsReadSchema } from './schema/model.ts';
import { refusals } from './schema/refusals.ts';
import {
  type SelectionReadSchema,
  SelectionResultSchema,
  type SelectionUpdateSchema,
} from './schema/selection.ts';
import { controlTarget } from './target.ts';

export function exactNativeTarget(
  m: MachineConfig,
  input: z.output<typeof SelectionReadSchema>,
): Session {
  const session = controlTarget(m, input.target);
  if (!hasNativeRuntime(session) || session.archived)
    throw refusals.errors.UNSUPPORTED({
      message: 'An active managed native registration is required',
    });
  if (session.registrationGeneration !== input.registrationGeneration)
    throw refusals.errors.IDENTITY_MISMATCH({ message: 'Managed registration changed' });
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
  throw refusals.errors.PRECONDITION_FAILED({
    message: 'Model catalog exceeds the bounded selection window',
  });
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
    throw refusals.errors.PRECONDITION_FAILED({
      message: 'Initial native selection has not been observed',
    });
  return { revision: 0, options: initialTurnOptions(s, model) };
}

/**
 * Whether the catalog row offers the requested effort.
 *
 * Keyed on the field, not on a runtime: written as a `runtime === 'codex'` branch it let every
 * native Claude turn past, including a level on a model whose own row offers none. A row that lists
 * no efforts accepts no effort — that is what a model without the parameter reports.
 */
export function effortAccepted(
  row: { supportedReasoningEfforts?: readonly { reasoningEffort: string }[] | undefined },
  effort: string | undefined,
): boolean {
  if (effort === undefined) return true;
  return row.supportedReasoningEfforts?.some((item) => item.reasoningEffort === effort) === true;
}

export async function validateTurnOptions(
  m: MachineConfig,
  s: Session,
  options: NativeTurnOptions,
  signal: AbortSignal,
  images = false,
): Promise<void> {
  if (options.runtime !== s.agent)
    throw refusals.errors.UNSUPPORTED({ message: 'Selection runtime differs from its session' });
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
  // Two different answers, told apart: the catalog does not offer this key at all, or it offers it
  // and the row takes no image. One message for both sent a caller checking its request shape when
  // the request was fine and the model was simply the wrong one.
  const label = modelSelectionLabel(options.model);
  if (row === undefined)
    throw refusals.errors.UNSUPPORTED({
      message: `Model ${label} is absent from this runtime's catalog`,
    });
  if (images && !row.inputModalities.includes('image'))
    throw refusals.errors.UNSUPPORTED({ message: `Model ${label} does not accept image input` });
  if (!effortAccepted(row, 'effort' in options ? options.effort : undefined))
    throw refusals.errors.UNSUPPORTED({
      message: `Model ${label} does not offer the requested effort`,
    });
  if (options.runtime === 'opencode') {
    const choices = preparedOpenCodeChoices(m, s);
    if (
      (options.agent !== undefined && !choices.agents.includes(options.agent)) ||
      (options.variant !== undefined && !row.variants?.includes(options.variant))
    )
      throw refusals.errors.UNSUPPORTED({
        message: 'Requested native agent or variant is unavailable',
      });
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
    throw refusals.errors.NOT_IDLE({ message: 'Native session is not between turns' });
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
    const fingerprint = createHash('sha256').update(stableJson(input)).digest('hex');
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
      throw refusals.errors.REVISION_CONFLICT({ message: 'Session selection changed' });
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
