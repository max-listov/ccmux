import { z } from 'zod';
import { AgentKindSchema, ManagedPeerSchema } from '../../chat/identitySchema.ts';
import {
  LaunchRecipeMetadataSchema,
  LaunchRecipeReferenceSchema,
} from '../../config/launchSchema.ts';

export const CONTROL_MODELS_MAX_PAGE = 64;
export const ControlModelsReadSchema = z
  .object({
    runtime: AgentKindSchema.optional(),
    target: ManagedPeerSchema.optional(),
    launchRecipe: LaunchRecipeReferenceSchema.optional(),
    cursor: z.string().min(1).max(4_096).nullable().default(null),
    limit: z.number().int().min(1).max(CONTROL_MODELS_MAX_PAGE).default(CONTROL_MODELS_MAX_PAGE),
    includeHidden: z.boolean().default(false),
  })
  .strict()
  .refine(
    (input) => input.target === undefined || input.launchRecipe === undefined,
    'Choose a host recipe or an exact managed runtime, not both',
  );
export type ControlModelsRead = z.input<typeof ControlModelsReadSchema>;
export const ControlModelSchema = z
  .object({
    provider: z.string().min(1).max(128).optional(),
    id: z.string().min(1).max(256),
    model: z.string().min(1).max(256).optional(),
    displayName: z.string().min(1).max(256),
    description: z.string().max(2_048),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    inputModalities: z.array(z.string().min(1).max(64)).max(16),
    serviceTiers: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(256),
            description: z.string().max(1_024),
          })
          .strict(),
      )
      .max(16),
    supportedReasoningEfforts: z
      .array(
        z
          .object({
            reasoningEffort: z.string().min(1).max(64),
            description: z.string().max(1_024),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    defaultReasoningEffort: z.string().min(1).max(64).optional(),
    variants: z.array(z.string().min(1).max(128)).max(64).optional(),
  })
  .strict();
export type ControlModel = z.infer<typeof ControlModelSchema>;
export const ControlModelCatalogSchema = z
  .object({
    target: ManagedPeerSchema.optional(),
    source: z
      .object({
        kind: z.enum(['host', 'session']),
        machine: z.string().min(1),
        provider: z.string().min(1).max(128).nullable(),
        /** Which server backs `provider`, when the host declared one. Reported, never matched on. */
        providerLabel: z.string().max(64).nullable().default(null),
        runtime: AgentKindSchema,
        launchRecipe: LaunchRecipeMetadataSchema.optional(),
        /**
         * When this list was observed: for a runtime whose catalog only a running session can ask,
         * and for the Codex host catalog, which the daemon reads in the background and serves from
         * its last read because one read costs a metadata App Server start.
         *
         * Null where the answer is computed on the spot and the question does not arise. Where it
         * is not null it is load-bearing: a list left behind by a session that has since stopped, or
         * read some minutes ago, is still the best answer this host has, and calling it current
         * would be the lie.
         */
        observedAt: z.string().max(64).nullable().default(null),
        /**
         * Whether that observation is current: the publishing session is still running, or the host
         * catalog was read within the last ten minutes.
         *
         * `stale` is not a failure — it is "this is what it last said". A caller choosing a model
         * before creating a session wants exactly that, and wants to know which of the two it got.
         */
        freshness: z.enum(['live', 'stale']).nullable().default(null),
      })
      .strict(),
    data: z.array(ControlModelSchema).max(CONTROL_MODELS_MAX_PAGE),
    agents: z.array(z.string().min(1).max(128)).max(128).optional(),
    nextCursor: z.string().max(4_096).nullable(),
  })
  .strict()
  .refine(
    (catalog) =>
      catalog.source.kind === 'host'
        ? catalog.target === undefined
        : catalog.target !== undefined &&
          catalog.target.agent === catalog.source.runtime &&
          catalog.target.machine === catalog.source.machine,
    'Catalog source must match its exact managed identity',
  );
export type ControlModelCatalog = z.infer<typeof ControlModelCatalogSchema>;
