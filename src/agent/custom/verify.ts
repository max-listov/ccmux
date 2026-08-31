import { z } from 'zod';
import type { CustomLaunchConfig } from './config.ts';
import { customProviderLabel } from './host.ts';

/**
 * Does the provider actually serve what this host declared?
 *
 * The model registry is host-authored configuration and stays that way: a server listing a model is
 * not authorization to use it, so nothing here populates or edits the registry. What is missing is
 * any moment at which the declaration is checked against reality. A model id the server does not
 * serve, or a context window larger than the one it loaded, passes configuration validation and
 * surfaces later as a provider error attributed to the turn rather than to the configuration.
 *
 * Deliberately a diagnostic and nothing else: it is never a startup dependency and never runs before
 * a turn. An unreachable provider therefore reports `unknown`, never `missing` — "we could not look"
 * and "it is not there" are the two answers this exists to keep apart.
 */

/** What an OpenAI-compatible model list says. Loose on purpose: servers add fields, and the ones
 *  that matter here are optional across implementations. */
export const ServedModelSchema = z
  .object({
    id: z.string().min(1),
    max_context_length: z.number().int().positive().optional(),
    context_length: z.number().int().positive().optional(),
  })
  .loose();
export const ServedModelsSchema = z.object({ data: z.array(ServedModelSchema) }).loose();
export type ServedModel = z.infer<typeof ServedModelSchema>;

export type ContextVerdict = 'agrees' | 'declared-exceeds-served' | 'unverified';

export interface ModelVerdict {
  model: string;
  served: 'yes' | 'no' | 'unknown';
  declaredContextWindow: number;
  servedContextWindow: number | null;
  context: ContextVerdict;
}

export interface RegistryVerdict {
  provider: string;
  providerLabel: string | null;
  probe: 'reached' | 'unreachable' | 'not-queryable';
  reason: string | null;
  models: ModelVerdict[];
}

const servedContext = (model: ServedModel): number | null =>
  model.max_context_length ?? model.context_length ?? null;

/**
 * Compare a declaration with an answer, keeping "unpublished" apart from "contradicted".
 *
 * A server that does not report a context window has not disagreed with the host about one, so the
 * declared value stays declared and unverified. Only a number the server actually gave can
 * contradict it — and only in one direction: a host may deliberately declare a smaller window than
 * the server supports, while declaring a larger one is a prompt budget the server cannot honour.
 */
export function compareRegistry(
  config: CustomLaunchConfig,
  served: readonly ServedModel[] | null,
): ModelVerdict[] {
  const byId = new Map(served?.map((model) => [model.id, model]) ?? []);
  return config.models.map(({ selection, contextWindow }) => {
    if (served === null)
      return {
        model: selection.model,
        served: 'unknown' as const,
        declaredContextWindow: contextWindow,
        servedContextWindow: null,
        context: 'unverified' as const,
      };
    const match = byId.get(selection.model);
    const reported = match ? servedContext(match) : null;
    return {
      model: selection.model,
      served: match ? ('yes' as const) : ('no' as const),
      declaredContextWindow: contextWindow,
      servedContextWindow: reported,
      context:
        reported === null
          ? ('unverified' as const)
          : contextWindow > reported
            ? ('declared-exceeds-served' as const)
            : ('agrees' as const),
    };
  });
}

/** True when every declared model was found and nothing the server published contradicts it. */
export function registrySettled(verdict: RegistryVerdict): boolean {
  return (
    verdict.probe === 'reached' &&
    verdict.models.every(
      (model) => model.served === 'yes' && model.context !== 'declared-exceeds-served',
    )
  );
}

export async function verifyCustomRegistry(
  config: CustomLaunchConfig,
  credential: string | undefined,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 5_000,
): Promise<RegistryVerdict> {
  const label = customProviderLabel(config);
  if (config.provider.kind !== 'local')
    return {
      provider: config.provider.kind,
      providerLabel: label,
      probe: 'not-queryable',
      // Named rather than silently skipped: an aggregator's catalog is a vendor-wide inventory
      // reached by its own API, which is a different question from "does this server serve this".
      reason: 'this check reads an OpenAI-compatible model list; this provider does not expose one',
      models: compareRegistry(config, null),
    };
  const url = `${config.provider.endpoint.replace(/\/+$/, '')}/models`;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(credential === undefined ? {} : { headers: { Authorization: `Bearer ${credential}` } }),
    });
    if (!response.ok)
      return {
        provider: config.provider.kind,
        providerLabel: label,
        probe: 'unreachable',
        reason: `model list refused with HTTP ${response.status}`,
        models: compareRegistry(config, null),
      };
    const parsed = ServedModelsSchema.safeParse(await response.json());
    if (!parsed.success)
      return {
        provider: config.provider.kind,
        providerLabel: label,
        probe: 'unreachable',
        reason: 'model list was not an OpenAI-compatible response',
        models: compareRegistry(config, null),
      };
    return {
      provider: config.provider.kind,
      providerLabel: label,
      probe: 'reached',
      reason: null,
      models: compareRegistry(config, parsed.data.data),
    };
  } catch (error) {
    return {
      provider: config.provider.kind,
      providerLabel: label,
      probe: 'unreachable',
      reason: error instanceof Error ? error.message : 'model list could not be read',
      models: compareRegistry(config, null),
    };
  }
}

/** One line per model, saying what was checked rather than only whether it passed. */
export function verdictLines(verdict: RegistryVerdict): string[] {
  const head =
    verdict.probe === 'reached'
      ? `provider ${verdict.provider}${verdict.providerLabel ? ` (${verdict.providerLabel})` : ''} answered`
      : `provider ${verdict.provider}${verdict.providerLabel ? ` (${verdict.providerLabel})` : ''} ${verdict.probe} — ${verdict.reason ?? 'no reason given'}`;
  return [
    head,
    ...verdict.models.map((model) => {
      const served =
        model.served === 'yes' ? 'served' : model.served === 'no' ? 'NOT SERVED' : 'unknown';
      const context =
        model.context === 'agrees'
          ? `context ${model.declaredContextWindow} within ${model.servedContextWindow}`
          : model.context === 'declared-exceeds-served'
            ? `CONTEXT ${model.declaredContextWindow} EXCEEDS SERVED ${model.servedContextWindow}`
            : `context ${model.declaredContextWindow} declared, not published by the server`;
      return `  ${model.model} — ${served}; ${context}`;
    }),
  ];
}
