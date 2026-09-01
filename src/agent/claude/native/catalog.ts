import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { loadSessions } from '../../../config/sessions.ts';
import type {
  ControlModel,
  ControlModelCatalog,
  ControlModelsRead,
} from '../../../control/schema.ts';
import { hasNativeRuntime } from '../../../runtime/modes.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from '../../../runtime/status.ts';
import { readPrivateJson } from '../../../runtime/store.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { atomicWrite } from '../../../util/atomic.ts';
import { resolveAgentSdk } from './resolve.ts';

/**
 * The models this host's runtime actually offers, published by the writer that can ask.
 *
 * The catalog read runs in a different process from the session, and only the session holds a live
 * connection — so the owner asks once at startup and leaves the answer beside its status file, the
 * way the other native runtimes already do. A read that invented a list instead would be answering
 * about a runtime it never spoke to.
 */

const ModelSchema = z
  .object({
    provider: z.string().min(1).max(128),
    id: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    description: z.string().max(2_048),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    inputModalities: z.array(z.string().min(1).max(64)).max(16),
    serviceTiers: z
      .array(z.object({ id: z.string(), name: z.string(), description: z.string() }))
      .max(8),
    supportedReasoningEfforts: z
      .array(z.object({ reasoningEffort: z.string(), description: z.string() }).strict())
      .max(32)
      .optional(),
  })
  .strict();
const PreparedSchema = z
  .object({
    registrationGeneration: z.uuid(),
    /**
     * When the owner asked the runtime for this list.
     *
     * Optional because catalogs written before this field existed are still the best answer this
     * host has; a read falls back to the file's own timestamp rather than discarding them.
     */
    observedAt: z.string().max(64).optional(),
    models: z.array(ModelSchema).max(128),
  })
  .strict();
const MAX_BYTES = 512 * 1024;
const path = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'models.json');

/**
 * One page of a catalog, and one place that decides what a page is.
 *
 * Both reads — the session's and the host's — answer from the same stored list, so paging them
 * differently would give a caller two cursor vocabularies for one catalog.
 */
function page(
  models: readonly ControlModel[],
  input: ControlModelsRead,
  source: ControlModelCatalog['source'],
  target?: ControlModelCatalog['target'],
): ControlModelCatalog {
  const visible = input.includeHidden ? models : models.filter((model) => !model.hidden);
  const digest = createHash('sha256').update(JSON.stringify(visible)).digest('hex').slice(0, 16);
  let offset = 0;
  if (input.cursor) {
    const [revision, start] = input.cursor.split(':');
    if (revision !== digest || !start || !/^\d+$/.test(start) || Number(start) > visible.length)
      throw new AppError('INVALID_CURSOR', 'Native catalog cursor requires a fresh baseline', 409);
    offset = Number(start);
  }
  const limit = input.limit ?? 64;
  return {
    ...(target === undefined ? {} : { target }),
    source,
    data: visible.slice(offset, offset + limit),
    nextCursor: offset + limit < visible.length ? `${digest}:${offset + limit}` : null,
  };
}

/** What the runtime reported about a model, kept to the fields a chooser needs. */
export interface SupportedModel {
  value: string;
  displayName?: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: readonly string[];
}

/**
 * What the runtime says a model's effort levels are, in the shape a chooser reads.
 *
 * A turn carrying an effort is validated against this list, so a model that reports none accepts no
 * effort at all — which is the honest answer for a model without the parameter, and the reason this
 * is read from the runtime rather than filled in with the five names the type happens to allow.
 */
function efforts(model: SupportedModel): { reasoningEffort: string; description: string }[] {
  if (model.supportsEffort === false) return [];
  return (model.supportedEffortLevels ?? []).slice(0, 32).map((level) => ({
    reasoningEffort: level,
    description: '',
  }));
}

/**
 * Map the runtime's answer into the catalog shape.
 *
 * `provider: 'claude'` on every row, because that is what serves them — the same word the session's
 * own provenance carries, so a chooser never has to reconcile two names for one runtime.
 */
export function claudeModels(
  models: readonly SupportedModel[],
  current: string | null,
): ControlModel[] {
  return models.slice(0, 128).map((model) => ({
    provider: 'claude',
    id: model.value,
    /**
     * The id a caller SELECTS with, not the one it resolves to.
     *
     * Turn validation matches a session's stored selection against this field, and a selection
     * carries the alias a person chose (`haiku`), not the wire id behind it
     * (`claude-haiku-4-5-…`). Publishing the resolved id here made every alias selection look like a
     * model the catalog does not offer, and the control plane refused the turn.
     */
    model: model.value,
    displayName: (model.displayName ?? model.value).slice(0, 256),
    // The resolved id is real information a chooser wants; it just is not the matching key.
    description: [model.description ?? '', model.resolvedModel ? `→ ${model.resolvedModel}` : '']
      .filter((part) => part.length > 0)
      .join(' ')
      .slice(0, 2_048),
    hidden: false,
    // The runtime reports what it would use when nobody chooses; marking that row is how a chooser
    // shows "current" without a second request.
    isDefault: current !== null && (model.value === current || model.resolvedModel === current),
    /**
     * Stated here rather than reported: the runtime's model list carries no modality field at all.
     * Every model this runtime offers accepts images, which is a property of the family and not a
     * guess about an unknown row — and the alternative was worse than a label, because a catalog
     * claiming text-only makes the control plane REFUSE an image the runtime would have accepted.
     */
    inputModalities: ['text', 'image'],
    serviceTiers: [],
    ...(efforts(model).length === 0 ? {} : { supportedReasoningEfforts: efforts(model) }),
  }));
}

export async function writeClaudeCatalog(
  m: MachineConfig,
  s: Session,
  models: readonly ControlModel[],
): Promise<void> {
  const bytes = JSON.stringify(
    PreparedSchema.parse({
      registrationGeneration: s.registrationGeneration,
      observedAt: new Date().toISOString(),
      models,
    }),
  );
  if (Buffer.byteLength(bytes) > MAX_BYTES)
    throw new Error('Native Claude catalog exceeds its bounded projection');
  await atomicWrite(path(m, s), bytes, 0o600);
}

/**
 * The list this host last observed, from whichever owner published it.
 *
 * A caller choosing a model does so BEFORE creating the session that would carry the choice, so
 * "ask a running session" is a circle with no way out: the list needs a session, the session needs
 * the list. The way out is that the list is not a property of a conversation at all — it is what
 * the installed CLI and the operator's settings offer, and every owner on this host receives the
 * same one at startup, before its first turn.
 *
 * So the answer is the newest catalog any owner left behind, said to be exactly that: with when it
 * was observed, and whether the session that published it is still running. A list from a session
 * that has since stopped is still the best answer this host has; calling it current would be the
 * lie, and refusing to give it at all is what sent callers off to hardcode model names.
 */
function hostCatalog(
  m: MachineConfig,
): { models: readonly ControlModel[]; observedAt: string | null; live: boolean } | null {
  let best: { models: readonly ControlModel[]; observedAt: string | null; live: boolean } | null =
    null;
  for (const candidate of loadSessions(m)) {
    if (candidate.agent !== 'claude' || !hasNativeRuntime(candidate)) continue;
    const file = path(m, candidate);
    const prepared = readPrivateJson(file, PreparedSchema, MAX_BYTES);
    if (prepared === null) continue;
    // A catalog written before the field existed still counts; its file says when it was written.
    let observedAt = prepared.observedAt ?? null;
    if (observedAt === null) {
      try {
        observedAt = statSync(file).mtime.toISOString();
      } catch {
        observedAt = null;
      }
    }
    const live = readManagedRuntimeStatus(m, candidate).status === 'live';
    // Newest wins, and a live publisher outranks a stopped one at the same instant: both describe
    // the same installation, and the live one can still be asked again.
    const better =
      best === null ||
      (live && !best.live) ||
      (live === best.live && (observedAt ?? '') > (best.observedAt ?? ''));
    if (better) best = { models: prepared.models, observedAt, live };
  }
  return best;
}

/**
 * Answer without a session, or say precisely why this host cannot.
 *
 * Three different answers, because they call for three different actions: a host that does not run
 * this mode at all, a host that runs it but has never had an owner publish a list, and a list.
 * Collapsing the first two into an empty array would tell a chooser the runtime offers no models.
 */
function readClaudeHostModels(m: MachineConfig, input: ControlModelsRead): ControlModelCatalog {
  if (input.launchRecipe !== undefined)
    throw new AppError('UNSUPPORTED', 'This runtime does not accept a Codex launch recipe', 409);
  if (!('path' in resolveAgentSdk(m)))
    throw new AppError('UNSUPPORTED', 'This host does not publish a catalog for this runtime', 409);
  const best = hostCatalog(m);
  if (best === null)
    // Enabled, but nobody has ever held it here. Not "no models" — nothing observed yet.
    throw new AppError('UNAVAILABLE', 'No session on this host has published its catalog', 503);
  return page(best.models, input, {
    kind: 'host',
    machine: m.rcPrefix,
    runtime: 'claude',
    provider: 'claude',
    providerLabel: null,
    observedAt: best.observedAt,
    freshness: best.live ? 'live' : 'stale',
  });
}

export function readClaudeModels(
  m: MachineConfig,
  input: ControlModelsRead,
  session: Session | undefined,
): ControlModelCatalog {
  if (session === undefined) return readClaudeHostModels(m, input);
  if (!hasNativeRuntime(session))
    // The interactive mode has no catalog to read, and answering with the native mode's
    // unavailability would describe a runtime this session is not running. Dispatch keys on the
    // agent alone, so this is where the two modes part.
    throw new AppError('UNSUPPORTED', 'This runtime does not expose a model catalog', 409);
  if (input.launchRecipe !== undefined)
    throw new AppError('UNSUPPORTED', 'This runtime does not accept a Codex launch recipe', 409);
  const prepared = readPrivateJson(path(m, session), PreparedSchema, MAX_BYTES);
  if (
    prepared === null ||
    prepared.registrationGeneration !== session.registrationGeneration ||
    readManagedRuntimeStatus(m, session).status !== 'live'
  )
    throw new AppError('UNAVAILABLE', 'Native runtime catalog is unavailable', 503);
  return page(
    prepared.models,
    input,
    {
      kind: 'session',
      machine: m.rcPrefix,
      runtime: 'claude',
      provider: 'claude',
      providerLabel: null,
      observedAt: prepared.observedAt ?? null,
      // Read from the session that holds the runtime right now, so it is current by construction.
      freshness: 'live',
    },
    input.target,
  );
}
